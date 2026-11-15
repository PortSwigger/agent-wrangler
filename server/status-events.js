import fs from 'node:fs';
import path from 'node:path';
import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';

// Session status as events (docs/session-api.md, "Status events"). A session on
// a runtime that declares `statusEvents: true` posts each state change to
// POST /status-event on the session API; its card's status comes from the last
// event instead of the agent's status files.

export const STATUS_EVENT_STATES = ['working', 'waiting-permission', 'waiting-input', 'idle'];
export const STATUS_EVENT_MAX_BYTES = 1024;
const DETAIL_MAX = 200;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KEYS = new Set(['state', 'at', 'sessionId', 'detail']);

// Null for a valid body, else the reason it is refused. The body is exactly
// { state, at?, sessionId?, detail? }; any other key is refused.
export function statusEventError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body must be a JSON object';
  for (const k of Object.keys(body)) if (!KEYS.has(k)) return `unknown field "${k}"`;
  if (!STATUS_EVENT_STATES.includes(body.state)) return `state must be one of ${STATUS_EVENT_STATES.join(', ')}`;
  if (body.at !== undefined && !(Number.isSafeInteger(body.at) && body.at > 0)) return 'at must be a positive integer (milliseconds since the epoch)';
  if (body.sessionId !== undefined && !(typeof body.sessionId === 'string' && SESSION_ID_RE.test(body.sessionId))) return 'sessionId must be 1-128 letters, digits, - or _';
  if (body.detail !== undefined && !(typeof body.detail === 'string' && body.detail.length <= DETAIL_MAX)) return `detail must be a string of at most ${DETAIL_MAX} characters`;
  return null;
}

// The card fields an event sets: the board's status, and for needs-you what it
// waits for and why.
export function cardStatusOf(event) {
  switch (event?.state) {
    case 'working': return { status: 'working', waitingFor: null, waitingReason: null };
    case 'idle': return { status: 'idle', waitingFor: null, waitingReason: null };
    case 'waiting-permission': return { status: 'needs-you', waitingFor: event.detail || 'Waiting for permission', waitingReason: 'permission' };
    case 'waiting-input': return { status: 'needs-you', waitingFor: event.detail || 'Waiting for your input', waitingReason: null };
    default: return { status: 'unknown', waitingFor: null, waitingReason: null };
  }
}

// The last event per card, kept in memory and in `file` so a server restart
// shows the same status until the next event. An event older (by `at`) than the
// one held is dropped: hooks may run concurrently and arrive out of order.
export function createStatusEventStore({ file, onError = () => {} }) {
  const byCard = new Map();
  const saved = file ? readJsonOrLoud(file, 'session status events') : null;
  for (const [cardId, ev] of Object.entries(saved?.cards || {})) {
    if (!statusEventError({ state: ev?.state, at: ev?.at, sessionId: ev?.sessionId, detail: ev?.detail })) byCard.set(cardId, ev);
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, { cards: Object.fromEntries(byCard) });
    } catch (err) { onError('[status-events] saving failed', err); }
  }

  return {
    record(cardId, body, now = Date.now()) {
      const at = body.at ?? now;
      const held = byCard.get(cardId);
      if (held && held.at > at) return false;
      const ev = { state: body.state, at };
      if (body.sessionId) ev.sessionId = body.sessionId;
      if (body.detail) ev.detail = body.detail;
      byCard.set(cardId, ev);
      save();
      return true;
    },
    get(cardId) {
      return byCard.get(cardId) || null;
    },
    forget(cardId) {
      if (byCard.delete(cardId)) save();
    },
  };
}

function reply(res, code, body) {
  if (body === undefined) { res.writeHead(code).end(); return; }
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

// The POST /status-event handler, run after the session API's caller check with
// the resolved card id. `accepts(cardId)` is false for a card the board knows on
// a runtime that has not opted in, whose status stays file-based; a card not
// recorded yet is accepted (a hook can fire before its launch is recorded).
export function createStatusEventHandler({ store, accepts = () => true, onEvent = () => {} }) {
  return function statusEventHandler(req, res, cardId) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { req.resume(); reply(res, 415, { error: 'bad-content-type', reason: 'send application/json' }); return; }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > STATUS_EVENT_MAX_BYTES) { req.resume(); reply(res, 413, { error: 'too-large', reason: `the body is capped at ${STATUS_EVENT_MAX_BYTES} bytes` }); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > STATUS_EVENT_MAX_BYTES) {
        done = true;
        reply(res, 413, { error: 'too-large', reason: `the body is capped at ${STATUS_EVENT_MAX_BYTES} bytes` });
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => { done = true; });
    req.on('end', () => {
      if (done) return;
      done = true;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(res, 400, { error: 'bad-body', reason: 'the body is not JSON' }); return; }
      const err = statusEventError(body);
      if (err) { reply(res, 400, { error: 'bad-body', reason: err }); return; }
      if (!accepts(cardId)) { reply(res, 409, { error: 'not-opted-in', reason: 'this card\'s runtime takes status from files, not events' }); return; }
      if (store.record(cardId, body)) onEvent(cardId);
      reply(res, 204);
    });
  };
}
