import fs from 'node:fs';
import os from 'node:os';
import { resolveResumeDir } from './transcript-reader.js';
import { sendText as defaultSendText } from './tmux-scraper.js';
import { adapterFor } from './agents/index.js';
import { cloudSteerWins, sendCloudMessage as defaultSendCloudMessage } from './cloud-steer.js';

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
  const entry = sessionManager.entryFor(id);

  // Cloud route, ahead of the live-pane paste (see cloudSteerWins on why the
  // ordering is load-bearing). It lives HERE rather than in
  // control/handlers/message.js because send_message's legacyPushFallback — the
  // path every cloud card takes, since mailCapable is false for cloud — also
  // ends up in deliverMessage; one branch here covers the human-typed card
  // message and peer mail's direct push both. This does NOT unify the two
  // delivery paths: mailbox-delivery.js keeps its own cloud branch and its own
  // guards, and what they share is a shell-out leaf, not a routing decision.
  if (cloudSteerWins({ entry, tmux: target, attachSupported: cloudAttachSupportedFor(deps) })) {
    return deliverToCloud(id, text, entry, deps);
  }

  if (target) {
    await sendText(target, text, socketFor(id));
    return { mode: 'live' };
  }

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

// A cloud card is never resumed to receive a message — there is no host
// transcript to resume and the session is running somewhere we don't control.
// 'live' on success: the message reached the agent, which is what the caller's
// 'live' means; there is no dormant/wake concept for cloud.
async function deliverToCloud(id, text, entry, deps) {
  const steer = deps.sendCloudMessage ?? defaultSendCloudMessage;
  // Same hard refusal as the local path: an archived card left the board on
  // purpose. Checked here too because the generic check below sits after the
  // live-pane branch this one jumps ahead of.
  if (entry.archivedAt) {
    return { mode: 'error', error: `Session ${id} is archived; messaging an archived session isn't supported.` };
  }
  const res = await steer({ cloudSessionId: entry.cloud?.sessionId, text });
  if (res.ok) return { mode: 'live' };
  // Mark the card, don't just toast: an archived cloud session is a permanent
  // state the board should show, and the steer refusal is the only evidence of
  // it we ever get (nothing polls a cloud session's lifecycle).
  if (res.archived) deps.sessionManager.markCloudArchived?.(id);
  return { mode: 'error', error: res.error };
}

// The attach gate's answer, read off the graph field the server already emits
// rather than by importing cloud-attach.js — that keeps the gate's "one module
// asks the question" property (this consumes the published answer, exactly as
// the client's Terminal-button greying does) and needs no new deps wiring.
// A missing or stale graph reads as unsupported, which routes to the steer: the
// safe direction, since a cloud card's only live pane while attach is off is the
// exiting create pane.
function cloudAttachSupportedFor(deps) {
  return Boolean(deps.graph?.()?.cloudAttachSupported);
}
