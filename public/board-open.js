// What an extension asked the board to show — `api.openSession` / `api.openDiff`
// (slots.js apiFor, app.js openSessionInBoard) — split out of app.js so the
// bookkeeping can be tested without the board.
//
// Two pieces of state, because the request outlives the call twice over:
//   - `pending`: a card that was NOT on the board when it was asked for. app.js
//     sends `resume` and pendingSelect waits for the graph to bring it back;
//     tryFulfillPending then claims this to finish the job (tile out of the
//     tray, card scrolled into view, the diff opened if one was asked for).
//   - `watch`: the diff panel openDiff opened, and the onClose to call when THAT
//     panel closes. diff-view.js reports every close, whatever caused it.
//
// The latest request always wins: asking for another card drops a pending one
// (and its onClose, which never fires — its panel never opened), and a new
// openDiff replaces the watch BEFORE it touches the panel, so the old onClose
// does not fire for a close the new request itself caused.
export function createBoardOpen() {
  let pending = null; // { sessionId, diff, onClose }
  let watch = null;   // { sessionId, onClose }
  return {
    request(sessionId, { diff = false, onClose = null } = {}) {
      pending = { sessionId, diff, onClose };
    },
    // Called with whatever pendingSelect has just selected. Anything else
    // selected first means the user (or a deep link) moved on, so a stale
    // request is dropped rather than left to fire on a later restore.
    claim(sessionId) {
      const p = pending;
      pending = null;
      return p && p.sessionId === sessionId ? p : null;
    },
    // A later request that needed no restore: forget the pending one, and say
    // which card it was so app.js can disarm the pendingSelect it armed.
    drop() {
      const sid = pending?.sessionId ?? null;
      pending = null;
      return sid;
    },
    watchDiff(sessionId, onClose) {
      watch = typeof onClose === 'function' ? { sessionId, onClose } : null;
    },
    diffClosed(sessionId) {
      if (!watch || watch.sessionId !== sessionId) return;
      const { onClose } = watch;
      watch = null;
      onClose();
    },
  };
}
