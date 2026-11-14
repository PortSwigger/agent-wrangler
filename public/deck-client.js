import { deckOrigin } from './deck-origin.js';

// The board's only connection to a deck: GET /deck, then /ws?api=1 for the
// state stream, actions with results, and events. A deck whose major version
// differs is shown as incompatible and is never sent an action.
export const DECK_API_MAJOR = 1;

export function apiMajor(api) {
  const m = /^(\d+)(?:\.\d+)*$/.exec(typeof api === 'string' ? api : '');
  return m ? Number(m[1]) : null;
}

// One state frame as the graph the board has always drawn from: settings,
// status and each extension's state sit at the top level, as they did on the
// legacy graph frame. `history` stays absent when the frame leaves it out.
// `restore(record, fields)` puts a session's compat fields back onto it, for
// the graph extensions see; without it the board's own view stays as sent.
export function stateToGraph(frame, { restore = null } = {}) {
  const { type: _t, rev: _r, settings, status, ext, compat, ...rest } = frame;
  const graph = { ...rest, ...(settings || {}), ...(status || {}) };
  for (const v of Object.values(ext || {})) if (v && typeof v === 'object') Object.assign(graph, v);
  const fields = compat?.sessionFields;
  if (restore && fields && typeof fields === 'object') {
    const put = (r) => (r && Object.hasOwn(fields, r.sessionId) ? restore(r, fields[r.sessionId]) : r);
    if (Array.isArray(graph.sessions)) graph.sessions = graph.sessions.map(put);
    if (Array.isArray(graph.nodes)) graph.nodes = graph.nodes.map((n) => (n?.type === 'session' ? put(n) : n));
  }
  return graph;
}

// Drops every item whose `action` the deck cannot do for this card, then any
// separator left leading, trailing or doubled.
export function supportedItems(items, supports) {
  const out = [];
  for (const it of items) {
    if (it.action && !supports(it.action)) continue;
    if (it.sep && (!out.length || out.at(-1).sep)) continue;
    out.push(it);
  }
  if (out.at(-1)?.sep) out.pop();
  return out;
}

const refused = (code, message) => ({ ok: false, data: null, error: { code, message } });

export function createDeckClient({
  fetchImpl = (...a) => fetch(...a),
  WebSocketImpl = globalThis.WebSocket,
  location = globalThis.location,
  origin = () => deckOrigin(location),
  onStatus = () => {},
  onState = () => {},
  onEvent = () => {},
  onOpen = () => {},
  onClose = () => {},
  retryMs = 1500,
  incompatibleRetryMs = 30000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  let status = 'connecting';
  let descriptor = null;
  let actions = new Set();
  let ws = null;
  let seq = 0;
  let stopped = false;
  let handshake = null;
  const pending = new Map();

  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    onStatus(status, descriptor);
  };

  async function readDescriptor() {
    const res = await fetchImpl(`${origin().http}/deck`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET /deck answered ${res.status}`);
    return res.json();
  }

  function accept(d) {
    descriptor = d && typeof d === 'object' ? d : null;
    if (apiMajor(descriptor?.api) !== DECK_API_MAJOR) {
      actions = new Set();
      return false;
    }
    actions = new Set(Array.isArray(descriptor.actions) ? descriptor.actions : []);
    return true;
  }

  function settle(id, result) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p(result);
  }

  function openSocket() {
    const sock = new WebSocketImpl(`${origin().ws}/ws?api=${DECK_API_MAJOR}`);
    ws = sock;
    sock.onopen = () => { setStatus('ready'); onOpen(); };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type === 'state') onState(msg);
      else if (msg?.type === 'result') settle(msg.id, msg);
      else if (msg?.type === 'event') onEvent(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      for (const id of [...pending.keys()]) settle(id, refused('failed', 'The connection to the deck closed'));
      setStatus('connecting');
      onClose();
      if (!stopped) setTimer(start, retryMs);
    };
  }

  function start() {
    if (stopped) return Promise.resolve();
    handshake = (async () => {
      let d;
      try { d = await readDescriptor(); } catch {
        setStatus('unreachable');
        setTimer(start, retryMs);
        return;
      }
      if (!accept(d)) {
        setStatus('incompatible');
        setTimer(start, incompatibleRetryMs);
        return;
      }
      openSocket();
    })();
    return handshake;
  }

  // Re-reads the descriptor on a live connection, for when the deck's action
  // list changes (an extension enabled or disabled).
  function refresh() {
    handshake = readDescriptor().then((d) => {
      if (!accept(d)) {
        setStatus('incompatible');
        ws?.close();
      }
    }, () => {});
    return handshake;
  }

  function supports(action, session = null) {
    if (status === 'incompatible' || !actions.has(action)) return false;
    return !(Array.isArray(session?.unsupported) && session.unsupported.includes(action));
  }

  // Resolves with the deck's result frame, or a refusal made here when the
  // action is not one this deck advertises or the socket is down: neither
  // sends anything.
  async function act(action, { session = null, args = {} } = {}) {
    if (handshake) await handshake;
    if (status === 'incompatible') return refused('unsupported', 'This deck speaks an incompatible API version');
    if (!actions.has(action)) return refused('unsupported', `This deck does not offer ${action}`);
    if (!ws || ws.readyState !== 1) return refused('failed', 'Not connected to the deck');
    const id = ++seq;
    const result = new Promise((res) => pending.set(id, res));
    ws.send(JSON.stringify({ type: 'action', id, action, session, args }));
    return result;
  }

  // Synchronous twin of act's checks, for a caller that must know at once
  // whether the action went out.
  function canSend(action) {
    return status === 'ready' && actions.has(action) && ws?.readyState === 1;
  }

  return {
    start,
    refresh,
    supports,
    act,
    canSend,
    stop() { stopped = true; ws?.close(); },
    status: () => status,
    descriptor: () => descriptor,
  };
}
