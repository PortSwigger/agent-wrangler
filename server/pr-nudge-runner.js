import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText } from './tmux-scraper.js';
import { adapterFor } from './agents/index.js';

// Deliver a PR check-status transition nudge to the owning session, treating a
// DORMANT session exactly like an idle-but-live one — dormancy is only a RAM
// optimization (James: "behaviour should be the same for a dormant session as with
// an idle-but-live session"). ONE routing that branches on the target at fire time:
//   - LIVE (tmuxFor truthy): sendText the nudge into the pane (unchanged behavior).
//   - DORMANT (a mapping entry, not archived, not snoozed, no live tmux): wake it via
//     resume(). When we OWN the relaunch AND the agent's buildResume threads the intent
//     (Claude), the SAME nudge rides the resume intent so it auto-runs unattended with
//     no paste race against a booting agent (mirrors wakeCommentedSnooze). Otherwise —
//     a Codex resume (intent is a silent no-op) or ANY joined resume (coalescing ignores
//     our intent) — the nudge is pasted into the now-live pane after resume() resolves.
//   - ARCHIVED, SNOOZED, or GONE: do NOTHING — the board toast the caller already broadcast is
//     the only signal. The archived guard is load-bearing: prLinks()/entryFor()
//     surface archived entries (archive keeps the mapping entry) and resume() drops
//     archivedAt via resumeEntry, so waking one would resurrect a session that has
//     left the board — the same `!archivedAt` exclusion activeEntries() and
//     dueCommentedSnoozes() enforce.
//
// This is self-contained (its own resolveResumeDir/bindSession/resume block, mirroring
// snooze-wake-runner rather than delegating to runSessionAction) so the two
// concurrency guards below can sit SYNCHRONOUSLY immediately before resume() — the
// only place they close their windows. Deps injected (no session-manager import).
// Returns the mode: 'live' | 'dormant' | 'skip' (archived/gone) | 'error' (resume
// failed). Only 'dormant' warrants the caller's rebuild(); 'error' must NOT rebuild
// (nothing woke) and is surfaced via onError instead.
export async function deliverPrNudge(ev, entry, deps) {
  const { message, tmuxFor, socketFor, sessionManager, memoryStore, taskStore, onError } = deps;
  const sendText = deps.sendText ?? defaultSendText;
  const id = ev.ownerId;

  const target = tmuxFor(id);
  if (target) {
    await sendText(target, message, socketFor(id));
    return 'live';
  }

  // Not live: archived (entry with archivedAt), snoozed (entry with snooze), or gone
  // (no entry) is board-toast-only. Snooze short-circuits here alongside archived so a
  // snoozed card never runs resolveResumeDir/bindSession below (mutating its memory
  // binding) — a PR transition must not touch a card the user has snoozed.
  if (!entry || entry.archivedAt || entry.snooze) return 'skip';

  // Resolve the launch dir — the LAST await before resume(). A wrangler-created
  // worktree dir may have been cleaned up post-archive; recreate it (the transcript
  // lives under ~/.claude, so the conversation resumes), falling back to home.
  let dir = await resolveResumeDir(entry.liveSessionId || id, { entryCwd: entry.cwd });
  if (!dir || !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  // Bind memory BEFORE the relaunch (fully synchronous — all fs.*Sync), keyed on the
  // stable card id (matches resume.js / session-action-runner.js).
  memoryStore.bindSession(id, taskStore.taskFor(id)?.id || null);

  // ---- SYNCHRONOUS COMMIT BLOCK: NO await from here through resume() initiation. ----
  // FIX 1 — Archive-races-wake TOCTOU. resolveResumeDir above yielded; during that
  // window a user's archive WS message can set archivedAt on this entry, and
  // resume() → resumeEntry drops archivedAt, resurrecting a session that has left the
  // board. Re-read the entry FRESH here and, with NO await between this check and
  // resume() below, Node's single thread cannot interleave the archive handler: the
  // check→commit runs to completion in one turn, and resume() registers its _resuming
  // coalescing slot synchronously before its own first await, so the archived
  // exclusion and the resume commit are indivisible. Archived (or snoozed) in the window
  // ⇒ abort to board-toast-only (no resume, no onError). A dedicated claim TOKEN (like
  // snooze's clearSnooze) is NOT needed: snooze's token arbitrates two actors racing to
  // DELIVER ONE note; here the only contended mutation is un-archiving via resume(), and
  // the synchronous re-check + resume()'s own coalescing already make it atomic. A
  // snoozed session (Boolean(entry.snooze)) is excluded from the wake exactly like an
  // archived one — a PR transition is board-toast-only while the user has it snoozed —
  // and re-reading here also catches a snooze that lands during the resume-dir await.
  const fresh = sessionManager.entryFor(id);
  if (!fresh || fresh.archivedAt || fresh.snooze) return 'skip';

  // FIX 2 — Nudge lost to resume() coalescing (the important one). resume() returns
  // the IN-FLIGHT promise for a card id and IGNORES a later caller's opts.intent. If a
  // manual Resume (no intent) is already in _resuming, our resume(id, dir, {intent})
  // JOINS it and the nudge — the one signal meant to drive the fix — is silently,
  // PERMANENTLY dropped (diffCheckStatus already consumed the transition so it never
  // re-fires; the join SUCCEEDS so onError never runs). Detect ownership SYNCHRONOUSLY
  // right before resume() (no await, so it can't flip under us). The intent carries the
  // nudge ONLY when we OWN the relaunch AND this agent's buildResume threads the intent
  // into the relaunch command — true for Claude (`claude --resume -- <intent>`), false
  // for Codex (`codex resume` takes no trailing prompt, so the intent is a silent
  // no-op). Read the capability off the adapter (self-documenting, vs hardcoding an
  // agent-name string here). In every other dormant case — any Codex resume, or ANY
  // joined resume of either agent (coalescing ignores our intent) — deliver the nudge by
  // pasting into the now-live pane via sendText after resume() resolves (the joined
  // result carries the live tmux; its socket is on the entry resume() _save()s before
  // returning). We NEVER do both — intentCarriesNudge ⇒ intent already carried it ⇒ no
  // sendText — so there's no double delivery. Same-owner PRs transitioning in one sweep
  // also benefit: the first OWNS, each later one JOINS and delivers its own distinct
  // nudge, so every transition is delivered rather than the second silently coalesced.
  const owned = !sessionManager.isResuming(id);
  const intentCarriesNudge = owned && adapterFor(fresh.agent).resumeCarriesIntent;
  try {
    const res = await sessionManager.resume(id, dir, { intent: message });
    if (!intentCarriesNudge) {
      const tmux = res?.tmux ?? tmuxFor(id);
      const socket = sessionManager.entryFor(id)?.socket ?? '';
      // No explicit pane-readiness wait here: waitForPaneReady lives in the
      // control-handlers layer, which this leaf runner must not import — so this
      // mirrors the joined path's exact timing and shares its paste-timing residual.
      if (tmux) await sendText(tmux, message, socket);
      else onError?.(ev, new Error('resume produced no live pane to deliver the PR nudge'));
    }
  } catch (err) {
    onError?.(ev, err);
    return 'error';
  }
  return 'dormant';
}
