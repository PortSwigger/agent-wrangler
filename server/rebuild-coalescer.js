// Trailing-coalescing guard for rebuild(). rebuild() is triggered from a fixed 4s
// interval, a debounced file watcher, and ~15 direct handler calls (dispatch,
// rename, fork, attach, ...) with no serialization between them — two overlapping
// rebuild() calls race on shared per-session state (see transcript-reader.js's own
// analyze() coalescing, added for the same class of bug: a live symptom was
// several sub-agents flashing 'running' after a spurious wipe of their tracked
// state under concurrent access).
//
// Unlike createFullSweepGuard's skip semantics (poll-guard.js) — right for a
// periodic PR poll, where a starved tick just retries on the next timer — several
// callers here do `await rebuild()` immediately after a mutation (rename,
// dispatch, fork, attach) and rely on the broadcast reflecting THEIR change. A
// silent skip would leave those callers awaiting a stale pre-mutation graph until
// the next timer/watcher tick. So instead: a call arriving while a run is already
// in flight doesn't start its own run — it, and every other call that arrives
// during that same in-flight run, are collapsed into ONE trailing run that starts
// fresh once the in-flight run settles, and all of them resolve to that trailing
// run's result. This also serializes every call through `run`, so at most one
// `run()` executes at a time.
//
// `run` must be an async function (never throw synchronously, always return a
// promise) — `rebuildOnce` is. A synchronous throw here would leave any queued
// caller's deferred promise unsettled forever.
export function createRebuildCoalescer(run) {
  let inFlight = null;
  let queued = null;

  function start() {
    inFlight = run().finally(() => {
      inFlight = null;
      if (queued) {
        const next = queued;
        queued = null;
        start().then(next.resolve, next.reject);
      }
    });
    return inFlight;
  }

  return function coalesced() {
    if (!inFlight) return start();
    if (!queued) {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      queued = { promise, resolve, reject };
    }
    return queued.promise;
  };
}
