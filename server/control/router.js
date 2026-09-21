import { activeHandlers } from './handlers/index.js';

// Built lazily on the first frame rather than at import: the active list
// includes every enabled extension's handlers, and the loader behind
// activeHandlers() is memoised at boot by server/index.js — resolving it at
// import time would run the loader before index.js got to pass the core
// registry names in. One Object.fromEntries, per registry change.
let handlerByType = null;
function lookup(type) {
  if (!handlerByType) handlerByType = Object.fromEntries(activeHandlers().map((h) => [h.type, h]));
  return handlerByType[type];
}

// The map is the ONE place in the server that caches the extension registry
// rather than reading it per call, so every live register/unregister has to drop
// it — a handler installed live would otherwise never be found, and a
// disabled one would keep receiving frames. Called from index.js's
// `ctx.ext.changed()`, which is the single seam every registry change goes
// through.
export function invalidateHandlerMap() {
  handlerByType = null;
}

export function _resetRouterForTests() {
  invalidateHandlerMap();
}

// Parse one control-WS frame and dispatch it to its registered handler. A
// malformed frame is dropped silently (matches the original inline loop); an
// unknown type is a no-op; any handler throw is wrapped in the shared error
// envelope so a single bad action never tears down the socket.
// `handlers` is injectable so a test can pin the set (including an extension's
// tagged handler) without writing config.json — the same escape hatch
// buildMcpServer's `tools` gives, and it bypasses the process-wide memo.
export async function routeControlMessage(raw, ctx, { handlers = null } = {}) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const entry = handlers ? handlers.find((h) => h.type === msg.type) : lookup(msg.type);
  if (!entry) return;
  try {
    // An EXTENSION's handler (tagged by the loader) receives its own `host`
    // façade in place of `ctx` — it may only reach what its manifest declared.
    // A core handler is untagged and keeps `ctx`. The error envelope below is
    // unchanged for both: an extension handler throwing must still reply
    // {type:'error'} rather than tear down the socket.
    await (entry.extId ? entry.handler(msg, ctx.hostApiFor?.(entry.extId)) : entry.handler(msg, ctx));
  } catch (err) {
    ctx.reply({ type: 'error', message: String(err.message || err) });
  }
}
