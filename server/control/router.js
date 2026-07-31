import { HANDLER_BY_TYPE } from './handlers/index.js';

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
  const entry = HANDLER_BY_TYPE[msg.type];
  if (!entry) return;
  try {
    await entry.handler(msg, ctx);
  } catch (err) {
    ctx.reply({ type: 'error', message: String(err.message || err) });
  }
}
