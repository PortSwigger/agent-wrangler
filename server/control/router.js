import { activeHandlers } from './handlers/index.js';
import { runWithOrigin } from '../request-origin.js';
import { buildActionRegistry, handleAction } from '../deck/actions.js';
import { NATIVE_ACTIONS } from '../deck/native-actions.js';
import { routeLegacyMessage } from '../deck/legacy.js';

// The deck API's action registry. Built lazily on the first frame rather than
// at import: the active list includes every enabled extension's handlers, and
// the loader behind activeHandlers() is memoised at boot by server/index.js —
// resolving it at import time would run the loader before index.js got to
// pass the core registry names in. Rebuilt per registry change, so an
// extension enabled or disabled live appears in (or drops out of) it.
let actionRegistry = null;
export function deckActions() {
  if (!actionRegistry) actionRegistry = buildActionRegistry({ handlers: activeHandlers(), native: NATIVE_ACTIONS });
  return actionRegistry;
}

// The map is the ONE place in the server that caches the extension registry
// rather than reading it per call, so every live register/unregister has to drop
// it — a handler installed live would otherwise never be found, and a
// disabled one would keep receiving frames. Called from index.js's
// `ctx.ext.changed()`, which is the single seam every registry change goes
// through.
export function invalidateHandlerMap() {
  actionRegistry = null;
}

export function _resetRouterForTests() {
  invalidateHandlerMap();
}

// An EXTENSION's handler (tagged by the loader) receives its own `host` façade
// in place of `ctx` — it may only reach what its manifest declared. A core
// handler is untagged and keeps `ctx`. `ctx.origin`, when set, is the requesting
// tab's sender (an action call swaps ctx.reply for its own capture).
export async function invokeHandler(entry, msg, ctx) {
  if (entry.extId) {
    const reply = (payload) => ctx.reply({ ...payload, type: `ext:${entry.extId}` });
    await runWithOrigin(ctx.origin ?? ctx.reply, () => entry.handler(msg, ctx.hostApiFor?.(entry.extId), reply));
  } else {
    await entry.handler(msg, ctx);
  }
}

// Parse one control-WS frame and dispatch it. `{type:'action'}` is the frame a
// board sends, and it always gets a `{type:'result'}`: an unknown action is
// refused with `unsupported`, and any handler throw becomes a `failed` result,
// so a single bad action never tears down the socket. On a `legacy` connection
// (a /ws upgrade without ?api=) any other type goes through the legacy adapter,
// which runs it as the action its handler backs; otherwise it is dropped, as is
// a malformed frame.
// `handlers` is injectable so a test can pin the set (including an extension's
// tagged handler) without writing config.json — the same escape hatch
// buildMcpServer's `tools` gives, and it bypasses the process-wide memo.
export async function routeControlMessage(raw, ctx, { handlers = null, legacy = false } = {}) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  const registry = handlers ? buildActionRegistry({ handlers, native: NATIVE_ACTIONS }) : deckActions();
  if (msg.type === 'action') await handleAction(msg, ctx, { registry, invoke: invokeHandler });
  else if (legacy) await routeLegacyMessage(msg, ctx, { registry, invoke: invokeHandler });
}
