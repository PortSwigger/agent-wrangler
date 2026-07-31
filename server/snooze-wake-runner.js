import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText } from './tmux-scraper.js';

// Automated snooze wake. A snooze that has ELAPSED (until <= now) AND carries a
// non-empty comment auto-wakes: the note is delivered auto-submitted and the snooze
// cleared. A comment-less elapsed snooze is left exactly as before — it renders amber
// and waits for a human — so this never changes comment-less behavior. An ARCHIVED
// session is never a wake candidate: archive() keeps the mapping entry (and its
// snooze) rather than deleting it, so without this guard an archived+commented+due
// snooze would resurrect a session that has left the board — mirror activeEntries'
// `!archivedAt` filter here. Pure so the "which snoozes are due" rule is unit-testable.
// `entries` is [sessionId, entry] pairs.
export function dueCommentedSnoozes(entries, now) {
  const out = [];
  for (const [sessionId, entry] of entries) {
    if (!entry || entry.archivedAt) continue; // archived sessions never auto-wake
    const snooze = entry.snooze;
    if (!snooze || typeof snooze.until !== 'number' || snooze.until > now) continue;
    const comment = typeof snooze.comment === 'string' ? snooze.comment.trim() : '';
    if (comment) out.push({ sessionId, comment });
  }
  return out;
}

// Wake ONE due commented snooze and deliver its note automatically. Mirrors
// runSessionAction's live/dormant/gone branching, but this is the AUTOMATED path so
// the note is auto-submitted:
//   - LIVE (tmux alive): sendText (paste + Enter) into the pane.
//   - DORMANT (mapping entry, no live tmux): resume with the comment as the
//     `-- <prompt>` intent so it auto-runs unattended, no paste race against a
//     booting agent. Contrast Part C2's MANUAL WS-resume, which prefills WITHOUT
//     Enter and passes NO intent — the two dormant-wake paths are distinct on purpose.
//   - GONE (entry forgotten, or its snooze cleared/changed since the due-scan): skip.
//     (Archived sessions keep their entry but are excluded upstream by
//     dueCommentedSnoozes, so they never reach here.)
// CLAIM IS DELIVERY: the comment is read into a local, then a SINGLE clearSnooze runs
// in the same synchronous block BEFORE either branch delivers, and its return value is
// the claim token — we proceed ONLY if we actually removed the snooze. Ordering matters
// — the WS snoozeClearHandler / resumeHandler wake the SAME session and also claim via
// clearSnooze; whichever actor's clearSnooze returns true owns the one delivery. If a
// human already claimed it, our clearSnooze returns false and we skip entirely (no
// resume, no sendText) rather than double-deliver. Symmetrically, once we claim, a
// concurrent manual wake sees clearSnooze→false and stands down. Single-threaded ⇒
// exactly one winner. An already-empty comment (cleared/changed since the due-scan)
// also short-circuits to skip before the claim.
// Deps injected (no session-manager import), like runSessionAction.
export async function wakeCommentedSnooze(sessionId, deps) {
  const { sessionManager, tmuxFor, socketFor, memoryStore, taskStore } = deps;
  const sendText = deps.sendText ?? defaultSendText;

  const entry = sessionManager.entryFor(sessionId);
  const comment = typeof entry?.snooze?.comment === 'string' ? entry.snooze.comment.trim() : '';
  if (!comment) return { sessionId, mode: 'skip' }; // cleared/changed since the due-scan

  // clearSnooze is the atomic delivery CLAIM: read the comment and claim it in the
  // SAME synchronous block (no await between). If a HUMAN wake already claimed this
  // session (clearSnooze returns false), skip ENTIRELY — do NOT resume, do NOT
  // deliver; the manual side (snoozeClearHandler / resumeHandler) owns the single
  // delivery. Single-threaded ⇒ exactly one actor wins the claim ⇒ exactly one
  // delivery. The comment used below is the local read captured BEFORE the clear.
  const claimed = sessionManager.clearSnooze(sessionId);
  if (!claimed) return { sessionId, mode: 'skip' };

  // LIVE: deliver into the running pane (paste + Enter). We already own the claim, so
  // a concurrent Unsnooze that arrives now sees clearSnooze→false and won't re-paste.
  const target = tmuxFor(sessionId);
  if (target) {
    await sendText(target, comment, socketFor(sessionId));
    return { sessionId, mode: 'live' };
  }

  // DORMANT/suspended: resume with the comment as the relaunch prompt (auto-runs).
  // Resolve the launch dir by the LIVE id (transcript bucket), recreating a
  // cleaned-up worktree dir since there's no interactive prompt here — the
  // transcript lives under ~/.claude, so the conversation still resumes.
  let dir = await resolveResumeDir(entry.liveSessionId || sessionId, { entryCwd: entry.cwd });
  if (!dir || !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  // Bind memory BEFORE the relaunch, keyed on the stable card id (matches resume.js).
  memoryStore.bindSession(sessionId, taskStore.taskFor(sessionId)?.id || null);
  // Already CLAIMED above (clearSnooze before either branch) — deliver via the resume
  // intent so it auto-runs unattended.
  await sessionManager.resume(sessionId, dir, { intent: comment });
  return { sessionId, mode: 'dormant' };
}

// The tick: wake every due commented snooze, isolating failures so one bad wake can't
// abort the sweep (each iteration is try/caught — a throw never aborts the rest of the
// due set). On a failure we DON'T silently retry forever: a permanently-unresumable
// commented snooze (deleted/expired transcript) would otherwise re-select and re-throw
// every tick with no UI signal, unlike the manual resume path which surfaces one
// "Resume failed" toast and stops. So mirror that: CLEAR the failed snooze (so it isn't
// re-selected next tick) and surface it via deps.onWakeError (the caller broadcasts a
// snooze-wake-error toast naming the session, the schedule-error channel's twin). Both
// steps are themselves guarded so neither can crash the sweep. Returns the count woken
// so the caller can batch one rebuild.
export async function fireDueSnoozeWakes(deps, now = Date.now()) {
  let woken = 0;
  for (const { sessionId } of dueCommentedSnoozes(deps.entries(), now)) {
    try {
      const { mode } = await wakeCommentedSnooze(sessionId, deps);
      if (mode === 'live' || mode === 'dormant') woken += 1;
    } catch (err) {
      try { deps.sessionManager.clearSnooze(sessionId); } catch { /* best effort */ }
      try { deps.onWakeError?.(sessionId, err); } catch { /* surfacing must never crash the sweep */ }
    }
  }
  return woken;
}

// Build the guarded tick that the 30s poll calls. fireDueSnoozeWakes runs serially
// and each dormant wake does a full resume (spawn tmux + CLI), so on a restart a
// backlog of past-due commented snoozes can make one sweep exceed the 30s interval.
// Without a guard the next tick would re-select the not-yet-processed sessions and
// resume them CONCURRENTLY with the still-running sweep — resuming the same session
// twice (the second killForSession kills the first agent; the note lands twice). The
// in-flight guard makes a tick that arrives mid-sweep a no-op. Returns { skipped }
// (else { skipped:false, woken }) so the skip is observable/testable. onWoken runs
// (the caller's rebuild) only after a sweep that woke something. Scoped to THIS tick —
// the schedule tick's semantics are untouched.
export function createSnoozeWakeSweeper(deps, { onWoken } = {}) {
  let sweeping = false;
  return async function sweep(now = Date.now()) {
    if (sweeping) return { skipped: true };
    sweeping = true;
    try {
      const woken = await fireDueSnoozeWakes(deps, now);
      if (woken && onWoken) await onWoken(woken);
      return { skipped: false, woken };
    } finally {
      sweeping = false;
    }
  };
}
