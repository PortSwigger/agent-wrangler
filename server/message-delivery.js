import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText, prefillPane as defaultPrefillPane, clearComposer as defaultClearComposer } from './tmux-scraper.js';
import { waitForComposerReady as defaultWaitForComposerReady, ensureSubmitted as defaultEnsureSubmitted } from './pane-ready.js';
import { adapterFor } from './agents/index.js';

// Deliver a message to a session, waking it first if it's dormant/suspended — the
// shared primitive behind send_message (MCP) and the `message` WS control handler.
// Unlike deliverPrNudge (an AUTOMATED nudge that skips snoozed targets), THIS is
// always a deliberate, addressed action: a human or peer chose this recipient on
// purpose. A live+snoozed session already receives a message today (nothing in the
// live path checks `snooze`), so treating dormant+snoozed differently would make
// delivery depend on whether the target happened to cross the idle-suspend threshold
// — snooze stays a "hide from my board" note to the human, not a do-not-disturb on
// incoming messages, uniformly across live and dormant. Archived is the one hard
// refusal: it left the board on purpose, and resume() would resurrect it by dropping
// archivedAt.
// `imagePaths` are ABSOLUTE, already resolved and existence-checked server-side
// (paste-store.js) — never a raw client value. Each is pasted as its OWN block,
// alone and before the prose, because that is the only shape Claude Code's TUI
// turns back into an attached image. Measured against a live pane: a bare path on
// its own line becomes `[Image #1]`, but the same path inside a MULTI-LINE paste,
// or with anything following it, stays literal text the model cannot see. So the
// path can never simply be concatenated into `text` — the split is the mechanism,
// not tidiness.
// Returns { mode: 'live' } | { mode: 'dormant' } | { mode: 'error', error }.
// `clearComposer` empties the pane's composer before anything is pasted. Set by
// the chat view when IT armed the restore that put text there: interrupting a turn
// makes Claude Code restore the interrupted prompt into the pane composer, and the
// chat view restores the same prompt into the browser composer, so sending the
// edited version pastes it onto the original and the agent gets both fused into one
// prompt. Only the armed case clears — a draft the human typed in the pane directly
// is theirs, and discarding it silently would be its own bug.
// `reason` is what a dormant target's relaunch is LOGGED as (session-manager's
// resume line, whose whole point is naming what woke a card) — it defaults to
// 'message' because a human pressing send and a peer's send_message are what
// this primitive was built for, and an extension's delivery passes its own so
// the log never claims a human sent it (see ext-deliver.js).
export async function deliverMessage(id, text, deps, { imagePaths = [], clearComposer: wantClear = false, reason = 'message' } = {}) {
  const { tmuxFor, socketFor, sessionManager, memoryStore, taskStore } = deps;
  const sendText = deps.sendText ?? defaultSendText;
  const prefillPane = deps.prefillPane ?? defaultPrefillPane;
  const clearComposer = deps.clearComposer ?? defaultClearComposer;
  const waitForComposerReady = deps.waitForComposerReady ?? defaultWaitForComposerReady;
  const ensureSubmitted = deps.ensureSubmitted ?? defaultEnsureSubmitted;

  // No Enter on any of these — prefillPane pastes and stops, so the TUI absorbs
  // each path into its composer and the single sendText below is what submits the
  // whole message, images and prose together, as ONE turn.
  // Ordered: clear first, then attachments, then the prose. Clearing after an
  // attachment would throw the attachment away with it.
  const attach = async (tmux, socket) => {
    if (wantClear) await clearComposer(tmux, socket);
    for (const p of imagePaths) await prefillPane(tmux, p, socket);
  };

  // A LIVE pane needs neither pane gate: it is long past its TUI boot, and a human
  // pressing Send chose this moment (this path also owns its own clearComposer
  // semantics for the interrupt-restore case). Only the post-resume path below,
  // pasting into a pty spawned milliseconds ago, has the readiness problem.
  const target = tmuxFor(id);
  if (target) {
    await attach(target, socketFor(id));
    await sendText(target, text, socketFor(id));
    return { mode: 'live' };
  }

  const entry = sessionManager.entryFor(id);
  if (!entry) return { mode: 'error', error: `Session ${id} not found (it may have been archived).` };
  if (entry.archivedAt) {
    return { mode: 'error', error: `Session ${id} is archived; messaging an archived session isn't supported.` };
  }

  // Resolve the launch dir by the LIVE id — a modern transcript is bucketed under
  // entry.liveSessionId, not the card id (legacy entries fall back to the card id,
  // which is their live id). A wrangler-created worktree dir may have been cleaned up
  // post-archive; recreate it since there's no interactive prompt here (the transcript
  // lives under ~/.claude, so the conversation still resumes), falling back to home.
  let dir = await resolveResumeDir(entry.liveSessionId || id, { entryCwd: entry.cwd });
  if (!dir || !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  // Bind memory BEFORE the relaunch so the resumed agent's AW_TASK_MEMORY resolves at
  // boot, keyed on the stable card id (matches resume.js / session-action-runner.js).
  memoryStore.bindSession(id, taskStore.taskFor(id)?.id || null);

  // ---- SYNCHRONOUS COMMIT BLOCK: no await between this re-check and resume(). ----
  // Mirrors deliverPrNudge's archive-race guard: the awaits above can straddle a
  // concurrent archive, and resume() would drop archivedAt and resurrect a session
  // that has left the board.
  const fresh = sessionManager.entryFor(id);
  if (!fresh || fresh.archivedAt) {
    return { mode: 'error', error: `Session ${id} was archived; message not delivered.` };
  }

  // resume() COALESCES concurrent resumes of the same card id, and a joiner's own
  // opts.intent is silently ignored. Detect ownership synchronously (no await since
  // the re-check above, so it can't flip under us) so we know whether the message
  // rides the resume intent or needs a fallback paste. The intent only carries the
  // message when we OWN the relaunch AND this agent's buildResume threads it in
  // (Claude, `claude --resume -- <intent>`); Codex's resume ignores the intent, and
  // ANY joined resume ignores it too — both fall back to sendText once resume()
  // resolves with a live pane, mirroring deliverPrNudge.
  const owned = !sessionManager.isResuming(id);
  // Attachments force the paste route. The resume-intent shortcut hands the text
  // to the CLI as a launch argument, which has no composer for a path to be
  // absorbed into — the images would simply be dropped, silently.
  const intentCarriesMessage = owned && !imagePaths.length && !wantClear && adapterFor(fresh.agent).resumeCarriesIntent;
  try {
    const res = await sessionManager.resume(id, dir, { intent: text, reason });
    if (!intentCarriesMessage) {
      const tmux = res?.tmux ?? tmuxFor(id);
      const socket = sessionManager.entryFor(id)?.socket ?? '';
      if (!tmux) return { mode: 'error', error: 'Session resumed but produced no live pane to deliver the message into.' };
      // HOLD the paste until the woken TUI has painted its composer. resume() only
      // guarantees the pty was spawned, and pasting into that window loses the
      // message SILENTLY: the bracketed paste is buffered and lands in the composer,
      // but the CR sendText sends 120ms behind it is dropped, so the text sits there
      // unsubmitted while this function returns mode 'dormant' and the chat view
      // reports "submitted". Measured on a real pane — stranded 3/3 at a 0ms gap,
      // 1 of 2 at 150ms, clean by 400ms — and caught end-to-end on the live board
      // twice. This is Codex's problem alone in practice, because Claude's
      // resumeCarriesIntent never pastes at all, and it is why the fix sits here
      // rather than in sendText, whose other callers all target settled panes.
      // A timeout falls THROUGH to the paste (see waitForComposerReady): a late
      // message beats a lost one.
      await waitForComposerReady(tmux, socket, fresh.agent);
      await attach(tmux, socket);
      await sendText(tmux, text, socket);
      // Then confirm the send actually became a turn, repairing a dropped CR with a
      // bare Enter — never a re-paste, which would fuse a second copy onto the text
      // already sitting in the composer. The repair is gated on our own text still
      // being visible in the composer, so it needs `text`/`agent` (see
      // ensureSubmitted); the readiness result deliberately does NOT gate it, since
      // a pane whose composer marker we failed to parse is exactly where the repair
      // is most needed.
      //
      // An unconfirmed send is reported as UNKNOWN, not success. Falling through a
      // readiness timeout and then claiming `submitted` would reinstate the silent
      // loss this whole change exists to remove — precisely on the version/resize
      // cases most likely to defeat the gate, where the message would be both late
      // AND lost. Unknown keeps the composer's draft client-side (the chat view
      // renders "Delivery status unknown" and does not clear it), so the human can
      // look at the pane and resend; a duplicate they can see beats a message that
      // vanished.
      if (!await ensureSubmitted(tmux, socket, { text, agent: fresh.agent })) {
        return { mode: 'dormant', outcome: 'unknown', error: 'Woke the session but could not confirm the message started a turn — check the terminal before sending again.' };
      }
    }
  } catch (err) {
    return { mode: 'error', error: err?.message || String(err), outcome: 'unknown' };
  }
  return { mode: 'dormant' };
}
