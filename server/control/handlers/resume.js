import { resolveResumeDir } from '../../transcript-reader.js';
import { ensureLaunchDir } from './resume-dir.js';
import { prefillPane, paneTitle, claudeTitle } from '../../tmux-scraper.js';
import { nudgeAndWaitForJobs } from './archive.js';

const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 400;

// Poll until the freshly-resumed agent has painted its prompt and can accept a
// prefill, so a send-keys -l doesn't race the booting CLI (a fixed sleep would
// either paste too early or stall unnecessarily). Readiness = the pane carries
// Claude's OSC title (claudeTitle non-null) — the same "this is a live agent
// pane" signal buildGraph trusts; a blank booting pane still has tmux's default
// hostname title, which claudeTitle rejects. Bounded: if the signal never lands
// (e.g. Codex sets no such title) we deliver anyway after the timeout rather than
// dropping the note. Capture/sleep injectable for testing.
export async function waitForPaneReady(name, socket, {
  timeoutMs = READY_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
  titleFn = paneTitle,
  readyFn = (title) => claudeTitle(title) != null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readyFn(await titleFn(name, socket))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

// Prefill the woken session's snooze note into its fresh pane once the agent is
// ready — no Enter, so the human reviews and submits it (the C2 suspended-snooze
// half of the wake-note flow). No-op when there's no note or no live pane.
// Standalone + deps-injectable (like waitForBackgroundShellClear) so the readiness
// gate and prefill are unit-testable without a real tmux pane; the resume handler
// passes optional ctx overrides, else the real tmux impls run.
export async function deliverWakeNote(name, socket, comment, {
  waitReady = waitForPaneReady,
  prefill = prefillPane,
} = {}) {
  if (!comment || !name) return false;
  await waitReady(name, socket);
  await prefill(name, comment, socket).catch(() => {});
  return true;
}

export const resumeHandler = {
  type: 'resume',
  async handler(msg, ctx) {
    const s = ctx.sessionFromGraph(msg.sessionId);
    const entry = ctx.sessionManager.entryFor(msg.sessionId);
    // clearSnooze is the atomic delivery CLAIM. Read the note and claim it in the
    // SAME synchronous block — NO await between the read and the clear — and BEFORE
    // resume(), so exactly one actor delivers. The 30s auto-wake sweep can claim +
    // relaunch-with-intent this same dormant session in the async window; because
    // resume() coalesces per-session (the _resuming map), our resume() below may JOIN
    // the sweep's in-flight relaunch and get back a pane where the note was ALREADY
    // auto-submitted via `intent`. Guarding delivery on our OWN claim prevents that
    // double delivery: if the sweep cleared the snooze first, our clearSnooze returns
    // false and we skip deliverWakeNote entirely. Clearing before resume() is safe —
    // resume() rebuilds via resumeEntry, which never reads entry.snooze. Delivered
    // AFTER resume — not via the resume `intent`/`-- <prompt>` path, which auto-runs
    // it — so the human reviews and hits Enter (the suspended-long-snooze half).
    const snoozeComment = entry?.snooze?.comment || '';
    const claimed = ctx.sessionManager.clearSnooze(msg.sessionId);
    // Resume from the session's launch dir (owns its project bucket), not its
    // latest cwd — a session that cd'd into a worktree is still bucketed under
    // where it started, and `claude --resume` only finds it from there. Look the
    // launch dir up by the LIVE id: a modern Claude transcript lives under
    // entry.liveSessionId, not the card id, so passing the card id here found no
    // transcript and silently disabled this recovery (legacy entries fall back to
    // the card id, which is their live id). Archived (History) sessions are off the
    // board, so s is null; fall back to the cwd persisted in the mapping rather
    // than stranding the resume in ~.
    const dir = await resolveResumeDir(entry?.liveSessionId || msg.sessionId, {
      graphCwd: s?.cwd,
      entryCwd: entry?.cwd,
    });
    if (!ensureLaunchDir({ dir, recreateDir: msg.recreateDir, reply: ctx.reply, sessionId: msg.sessionId })) {
      return;
    }
    // Bind memory BEFORE the relaunch so the forked agent's AW_TASK_MEMORY /
    // --add-dir resolve at boot. Keyed on the owner id (msg.sessionId), stable
    // across the fork, per the resume-fork invariant.
    ctx.memoryStore.bindSession(msg.sessionId, ctx.taskStore.taskFor(msg.sessionId)?.id || null);
    // Live restart with a background job running: nudge the agent to stop it FIRST,
    // then wait briefly before resume() kills the pane and relaunches. Shares
    // archiveHandler's nudgeAndWaitForJobs. If it doesn't clear in time we relaunch
    // anyway rather than block forever — the restart UI shows a plain "Restarting…"
    // toast, so we discard the boolean (no unclean reply); the wait is purely for its
    // side effect of giving the job a chance to end.
    if (msg.killJobsFirst && s?.tmux) {
      await nudgeAndWaitForJobs(s.tmux, s, { ctx, id: msg.sessionId });
    }
    // NB restart newly routes a *live* session through resume(): _doResume kills the
    // tmux BEFORE its resume refuse-guards (resumePlan/resumeLaunchPlan), so a refuse
    // drops the session to dormant (surfaced only as an error toast) rather than
    // leaving it live. For a live, messaged Claude the transcript exists on disk so a
    // refuse is near-unreachable here; not guarded, since reordering _doResume is a
    // flow change to a leaf other paths depend on. See the restart-session design.
    const { tmux } = await ctx.sessionManager.resume(msg.sessionId, dir);
    await ctx.rebuild();
    // Deliver the (pre-resume) snooze note into the freshly-launched pane once the
    // agent is ready. After rebuild, so the readiness wait never delays the board
    // reflecting the resumed card. ctx.waitForPaneReady/prefillPane are test seams
    // (undefined in prod → deliverWakeNote's real tmux defaults run).
    const socket = ctx.sessionManager.entryFor(msg.sessionId)?.socket ?? '';
    // Only deliver if WE won the claim above. If the sweep won it, the note already
    // rode the resume intent (deliverWakeNote also no-ops on an empty comment, but
    // gating on `claimed` is the explicit single-delivery contract).
    if (claimed && snoozeComment) {
      await deliverWakeNote(tmux, socket, snoozeComment, {
        waitReady: ctx.waitForPaneReady,
        prefill: ctx.prefillPane,
      });
    }
  },
};
