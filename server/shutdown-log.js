// One line on the way down, so restarts stop being indistinguishable. Measured
// before this existed: launchd reported 16 runs of the service and the log held
// no record of a single stop between them — a `kickstart -k`, a clean quit, a
// crash and an OOM kill all left the process simply reappearing.
//
// A SIGKILL still leaves nothing (no handler can run), and that absence is now
// itself the signal: a startup line with no shutdown line before it was a hard
// kill or a panic, not a restart anyone asked for.

import { log, humanDuration } from './log.js';

export function shutdownLine({ reason = null, code = 0, uptimeMs, pid }) {
  return `[agent-wrangler] shutting down (${reason || `exit code ${code}`}) — pid ${pid}, up ${humanDuration(uptimeMs)}`;
}

// The reason is RECORDED when it arrives and REPORTED once from the exit hook,
// rather than logged in both places — every ordinary stop passes through both, so
// logging at each would double-report it. Going through 'exit' also covers the
// paths nothing announces: process.exit(1) on a failed boot, or an event loop
// that simply empties.
//
// The signal handlers are installed HERE, at module load, and own the exit — they
// are not a second listener beside someone else's. Two reasons, and both were
// found the hard way. Installing a listener at all suppresses Node's default
// termination, so a handler that only recorded the signal would leave SIGTERM
// doing nothing and hang a `kickstart -k` until launchd escalated to SIGKILL. And
// registering them later (the first draft put them after the instance lock, which
// can wait seconds) left a real window where a stop during startup terminated by
// default disposition — 'exit' does not fire for that, so the stop went
// unrecorded and read exactly like the hard kill this is meant to distinguish.
// Cleanups (releasing the instance lock) register through `onShutdown` instead of
// adding their own handler, so there stays exactly one path down.
export function installShutdownLog({ pid = process.pid, startedAt = Date.now(), onLine = log } = {}) {
  let reason = null;
  const cleanups = [];
  process.on('exit', (code) => onLine(shutdownLine({ reason, code, uptimeMs: Date.now() - startedAt, pid })));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      reason = `signal ${sig}`;
      for (const fn of cleanups) { try { fn(); } catch { /* never block the exit on a cleanup */ } }
      process.exit(0);
    });
  }
  return {
    onShutdown: (fn) => cleanups.push(fn),
    // For a self-inflicted exit that knows why (the dev instance reaping itself):
    // records the reason so the exit hook's single line carries it, instead of the
    // caller logging its own line and leaving a bare "exit code 0" beside it.
    noteReason: (r) => { reason = r; },
  };
}
