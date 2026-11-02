// The board side of the `session.inputGate` slot (slots.js inputGate()): which
// sessions an extension has locked, and whether one chunk of xterm input may
// still reach a locked session's pane. A leaf, so both are unit-testable.

// xterm reports the mouse and focus through the same onData stream as typed
// keys. tmux runs `mouse on`, so these are how the wheel scrolls and a click
// lands; a lock only drops what the human TYPED. X10 (`ESC [ M` + 3 bytes),
// SGR (`ESC [ < b;x;y M|m`), urxvt (`ESC [ b;x;y M`) and focus in/out.
const POINTER_RE = /\x1b\[M[\s\S]{3}|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[[IO]/g;

// True when `data` is nothing but pointer/focus reports — a wheel burst can
// arrive as several reports in one chunk. Empty input is not a report.
export function pointerOnly(data) {
  return typeof data === 'string' && data.length > 0 && data.replace(POINTER_RE, '') === '';
}

// `gateFor(session)` is slots.inputGate bound to the current graph and api;
// `notify(session, gate)` is told the first time a locked session drops a
// keystroke, once per lock (it re-arms when the lock lifts).
export function createInputGates({ gateFor, notify = () => {} }) {
  let gates = new Map();
  const told = new Set();
  return {
    // Re-evaluate every session; true when any session's gate changed.
    refresh(sessions) {
      const next = new Map();
      for (const s of sessions || []) {
        const g = gateFor(s);
        if (g) next.set(s.sessionId, g);
      }
      let changed = next.size !== gates.size;
      for (const [id, g] of next) {
        const was = gates.get(id);
        if (!was || was.key !== g.key || was.reason !== g.reason || was.label !== g.label) changed = true;
      }
      for (const id of [...told]) if (!next.has(id)) told.delete(id);
      gates = next;
      return changed;
    },
    get(sessionId) {
      return (sessionId && gates.get(sessionId)) || null;
    },
    // May this chunk of terminal input reach the session's pane?
    allow(sessionId, data) {
      const g = this.get(sessionId);
      if (!g || pointerOnly(data)) return true;
      if (!told.has(sessionId)) {
        told.add(sessionId);
        notify(sessionId, g);
      }
      return false;
    },
  };
}
