import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText } from './tmux-scraper.js';
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
// Returns { mode: 'live' } | { mode: 'dormant' } | { mode: 'error', error }.
export async function deliverMessage(id, text, deps) {
  const { tmuxFor, socketFor, sessionManager, memoryStore, taskStore } = deps;
  const sendText = deps.sendText ?? defaultSendText;

  const target = tmuxFor(id);
  if (target) {
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
  const intentCarriesMessage = owned && adapterFor(fresh.agent).resumeCarriesIntent;
  try {
    const res = await sessionManager.resume(id, dir, { intent: text });
    if (!intentCarriesMessage) {
      const tmux = res?.tmux ?? tmuxFor(id);
      const socket = sessionManager.entryFor(id)?.socket ?? '';
      if (tmux) await sendText(tmux, text, socket);
      else return { mode: 'error', error: 'Session resumed but produced no live pane to deliver the message into.' };
    }
  } catch (err) {
    return { mode: 'error', error: err?.message || String(err) };
  }
  return { mode: 'dormant' };
}
