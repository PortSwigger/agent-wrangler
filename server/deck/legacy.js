import { stateToGraph } from '../../public/deck-client.js';
import { handleAction } from './actions.js';

// Adapters that keep surfaces older extensions use (a /ws connection without
// ?api=, GET /file, GET /ext-file) working on top of the deck API: each maps
// onto an action or a state frame and turns the answer back into the old
// shape. The first use of each logs one warning naming its replacement.
const warned = new Set();
export function warnLegacy(surface, replacement, log = (m) => console.warn(m)) {
  if (warned.has(surface)) return;
  warned.add(surface);
  log(`[agent-wrangler] ${surface} is deprecated and kept working through an adapter; use ${replacement} instead.`);
}
export const resetLegacyWarnings = () => warned.clear();

const restorePlain = (record, fields) => ({ ...record, ...fields });

// A state frame (parsed) as the legacy `{type:'graph'}` frame, serialised: the
// full session records, settings, status and extension keys at the top level,
// and history only when the state frame carries it.
export function legacyGraphFrame(state) {
  return JSON.stringify({ type: 'graph', graph: stateToGraph(state, { restore: restorePlain }) });
}

// A frame the deck API sends, as what a legacy client was sent: an event is
// its payload, a result is the handler's reply (or an error message for a
// failure). Null when a legacy client was sent nothing: a result with no
// reply, or an action the deck does not offer.
export function legacyReply(frame) {
  if (frame?.type === 'event') return frame.data ?? null;
  if (frame?.type !== 'result') return frame ?? null;
  if (frame.ok) return frame.data ?? null;
  if (frame.error?.code === 'unsupported') return null;
  return { type: 'error', message: frame.error?.message || 'failed' };
}

// The action a legacy control type names in `registry`, by the type of the
// handler behind it.
export function actionForLegacyType(registry, type) {
  if (typeof type !== 'string') return null;
  for (const entry of registry.values()) if (entry.handler?.type === type) return entry.action;
  return null;
}

// One legacy control message, run as its action. Replies go out on `ctx.reply`
// (the raw legacy send) in the old shapes.
export async function routeLegacyMessage(msg, ctx, { registry, invoke }) {
  warnLegacy('A /ws connection without ?api=', 'GET /deck and /ws?api=1 (action frames)');
  const action = actionForLegacyType(registry, msg.type);
  if (!action) return;
  const { type: _t, ...args } = msg;
  const send = (frame) => {
    const reply = legacyReply(frame);
    if (reply) ctx.reply(reply);
  };
  await handleAction({ type: 'action', id: 'legacy', action, args }, { ...ctx, send }, { registry, invoke });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

// GET /file?path=… and GET /ext-file?ext=<id>&path=…, answered by the
// session.file and deck.ext-file actions with the responses they always gave.
// Localhost posture: a foreign Host is refused, and no CORS header is sent.
export function createLegacyFileRoutes({ registry, ctx, allowedHost, logError = () => {} }) {
  const run = (action, args) => registry().get(action).run(args, ctx());
  async function file(req, res) {
    warnLegacy('GET /file', 'the session.file action');
    try {
      if (!allowedHost(req.headers.host)) return json(res, 403, { error: 'forbidden' });
      const data = await run('session.file', { path: new URL(req.url, 'http://localhost').searchParams.get('path') });
      json(res, 200, data);
    } catch (err) {
      if (err?.status) return json(res, err.status, { error: err.message });
      logError('[file]', err);
      if (!res.headersSent) json(res, 500, { error: 'read error' });
    }
  }
  async function extFile(req, res) {
    warnLegacy('GET /ext-file', 'the deck.ext-file action');
    try {
      if (!allowedHost(req.headers.host)) return json(res, 403, { ok: false, reason: 'forbidden' });
      const q = new URL(req.url, 'http://localhost').searchParams;
      json(res, 200, await run('deck.ext-file', { ext: q.get('ext'), path: q.get('path') }));
    } catch (err) {
      if (err?.reason) return json(res, 200, { ok: false, reason: err.reason });
      logError('[ext-file]', err);
      if (!res.headersSent) json(res, 200, { ok: false, reason: 'error' });
    }
  }
  return { file, extFile };
}
