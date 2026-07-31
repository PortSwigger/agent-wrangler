// Re-entrancy guard for the PR-status poll. setInterval fires on a fixed cadence
// regardless of whether the prior async tick has settled, so with many PR links a
// slow serial run of gh calls can exceed the interval and let two FULL sweeps run at
// once — each reassigning diffCheckStatus's prevChecks baseline from data fetched at
// different moments, which can REGRESS the baseline and re-fire a transition into a
// DUPLICATE wake/resume (a resurrection now, not just a stray toast). This wraps the
// raw sweep so a tick arriving while a full sweep is in flight is a no-op
// ({ skipped: true }) — the same `sweeping` in-flight flag the snooze sweeper uses
// (createSnoozeWakeSweeper), extracted here so it's unit-testable in isolation
// (index.js self-runs main() and can't be imported).
//
// Only the FULL sweep (only == null) is guarded. A TARGETED poll (`only` set — the
// on-attach / links-changed fast path) touches a single owner, never runs the
// transition diff (full-sweep-only in the caller), and must NOT be starved by a long
// full sweep, so it always runs. The single-owner flag + Node's single thread ⇒ at
// most one full sweep in flight at a time.
export function createFullSweepGuard(run) {
  let sweeping = false;
  return async function guarded(only = null) {
    if (only) return run(only);
    if (sweeping) return { skipped: true };
    sweeping = true;
    try {
      return await run(null);
    } finally {
      sweeping = false;
    }
  };
}
