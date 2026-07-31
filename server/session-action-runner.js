import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText } from './tmux-scraper.js';

// Fire a schedule that targets an EXISTING session — the `session` counterpart to
// runDispatch. ONE action that branches on the target's liveness at fire time:
//   - LIVE (a managed tmux): deliver `message` into the pane (a recurring nudge);
//     no message is a deliberate no-op success — a live session must not be torn
//     down to "resume" it, and there's nothing to deliver.
//   - DORMANT/suspended (has a mapping entry, no live tmux): resume it, threading
//     `message` through as the relaunch prompt so there's no paste-timing race
//     against a booting agent (a plain resume when there's no message).
//   - GONE (no mapping entry — archived): throw a clear Error.
// A throw becomes a schedule-error toast and never disables a recurring schedule.
// Deps are injected (no session-manager import) so this stays unit-testable with
// fakes, mirroring dispatch-runner. Keyed on the card id throughout (action.sessionId
// is the board handle, never a conversation id).
export async function runSessionAction(action, deps) {
  const { sessionManager, tmuxFor, socketFor, memoryStore, taskStore } = deps;
  const sendText = deps.sendText ?? defaultSendText;
  const id = action.sessionId;

  if (action.kind !== 'session') {
    throw new Error(`Unknown schedule action: ${action.kind}`);
  }

  const message = (action.message || '').trim();

  // LIVE: inject the message into the running pane. No message ⇒ nothing to do, but
  // that's success, not an error (resuming a live session would kill its tmux).
  const target = tmuxFor(id);
  if (target) {
    if (message) await sendText(target, message, socketFor(id));
    return { sessionId: id };
  }

  // Not live: a mapping entry means it's DORMANT/suspended → resume; no entry means
  // it was archived/removed, so there's nothing to act on.
  const entry = sessionManager.entryFor(id);
  if (!entry) throw new Error(`Session ${id} not found (it may have been archived).`);
  // Resume from the launch dir (resolveResumeDir prefers the persisted entry cwd).
  // Look it up by the LIVE id — a modern Claude transcript is bucketed under
  // entry.liveSessionId, not the card id (legacy entries fall back to the card id,
  // which is their live id). A wrangler-created worktree dir may have been cleaned
  // up after archive — there is no interactive recreate prompt here, so recreate it
  // (the transcript lives under ~/.claude, so the conversation resumes; only working
  // files are gone), falling back to home if even that fails.
  let dir = await resolveResumeDir(entry.liveSessionId || id, { entryCwd: entry.cwd });
  if (!dir || !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = os.homedir(); }
  }
  // Bind memory BEFORE the relaunch so the resumed agent's AW_TASK_MEMORY /
  // --add-dir resolve at boot, keyed on the stable card id (matches resume.js).
  memoryStore.bindSession(id, taskStore.taskFor(id)?.id || null);
  await sessionManager.resume(id, dir, { intent: message });
  return { sessionId: id };
}
