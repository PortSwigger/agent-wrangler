import { activeHandlers } from './handlers/index.js';

// Built lazily on the first frame rather than at import: the active list
// includes every enabled extension's handlers, and the loader behind
// activeHandlers() is memoised at boot by server/index.js — resolving it at
// import time would run the loader before index.js got to pass the core
// registry names in. One Object.fromEntries, once per process.
let handlerByType = null;
function lookup(type) {
  if (!handlerByType) handlerByType = Object.fromEntries(activeHandlers().map((h) => [h.type, h]));
  return handlerByType[type];
}

export function _resetRouterForTests() {
  handlerByType = null;
}

// Parse one control-WS frame and dispatch it to its registered handler. A
// malformed frame is dropped silently (matches the original inline loop); an
// unknown type is a no-op; any handler throw is wrapped in the shared error
// envelope so a single bad action never tears down the socket.
export async function routeControlMessage(raw, ctx) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const entry = lookup(msg.type);
  if (!entry) return;
  try {
    await entry.handler(msg, ctx);
  } catch (err) {
    ctx.reply({ type: 'error', message: String(err.message || err) });
  }
}
