// The promise behind `api.openDispatch({ taskId, intent, lockTask })`: the
// dispatch modal as an awaitable. Pure state, no DOM, so the rules unit-test.
//
// One call is "pending" from the moment the modal opens. It resolves with the
// server's `dispatched` ack once the human has LAUNCHED (`submit()`), or with
// null when the modal is closed without launching (or a newer call supersedes
// it). Concurrency: a second `open` while the first modal is merely OPEN
// replaces it — the first resolves null. While the first dispatch is IN FLIGHT
// (launched, awaiting its ack) a second `open` REJECTS, since the ack carries
// nothing that could tell two dispatches apart.
export function createDispatchWaiter() {
  let current = null; // { resolve, submitted }

  function settle(value) {
    const w = current;
    current = null;
    w?.resolve(value);
  }

  return {
    // `show()` opens the modal. It runs BEFORE this call's waiter is installed so
    // that anything it does to settle a stale one cannot settle this one.
    open(show) {
      if (current?.submitted) return Promise.reject(new Error('A dispatch is already in flight'));
      return new Promise((resolve) => {
        if (current) settle(null);
        show();
        current = { resolve, submitted: false };
      });
    },
    // The human pressed Launch and the `dispatch` frame went out.
    submit() { if (current) current.submitted = true; },
    // A `dispatched` ack arrived: it answers the call only if that call launched.
    ack(msg) { if (current?.submitted) settle(msg); },
    // The server answered the launch with an error. A modal still open (a
    // worktree dispatch pending) goes back to being a plain open modal the human
    // can retry from; a closed one will never be acked.
    error({ modalOpen }) {
      if (!current?.submitted) return;
      if (modalOpen) current.submitted = false;
      else settle(null);
    },
    // The modal closed. Without a launch that is a cancel; a launch already sent
    // from a modal that is now CLOSED keeps waiting for its ack, but one whose
    // modal was still held open pending the ack is abandoned.
    close({ wasPending }) {
      if (current && (!current.submitted || wasPending)) settle(null);
    },
    // Test/inspection seam.
    state: () => (current ? { submitted: current.submitted } : null),
  };
}
