import { deliverMessage } from '../../message-delivery.js';
import { resolvePasteNames } from '../../paste-store.js';

// Human-driven counterpart to the send_message MCP tool — same routing (live: paste
// into the pane; dormant: wake it and deliver; archived: refuse), via the shared
// deliverMessage primitive so the two paths can't drift.
//
// The chat composer may also carry pasted images. It sends back only the NAMES the
// upload handler gave it, never paths: resolvePasteNames is what turns those into
// absolute paths, and it refuses anything that is not a real file inside THIS
// session's own pastes folder. A client value must never reach a pane as a path.
export const messageHandler = {
  type: 'message',
  async handler(msg, ctx) {
    const replyResult = (ok, error, mode, outcome = ok ? 'submitted' : 'rejected') => {
      if (msg.requestId) ctx.reply({ type: 'message-result', requestId: msg.requestId, sessionId: msg.sessionId, ok, outcome, ...(error ? { error } : {}), ...(mode ? { mode } : {}) });
      else if (!ok) ctx.reply({ type: 'error', message: error });
    };
    const agent = ctx.sessionFromGraph?.(msg.sessionId)?.agent
      ?? ctx.sessionManager?.entryFor?.(msg.sessionId)?.agent;
    let imagePaths;
    try { imagePaths = resolvePasteNames(msg.sessionId, agent, msg.imageNames); }
    catch (err) { replyResult(false, err?.message || String(err)); return; }
    // An image on its own is a complete prompt (the TUI submits the bare
    // `[Image #1]`), so empty text is only an error when nothing is attached
    // either.
    if (!msg.text && !imagePaths.length) { replyResult(false, 'No message text given.'); return; }
    // clearComposer is set only by the chat view's Esc-then-edit flow, where the
    // wrangler's own interrupt is what put a restored prompt in the pane.
    let result;
    try { result = await deliverMessage(msg.sessionId, msg.text || '', ctx, { imagePaths, clearComposer: msg.clearComposer === true }); }
    catch (err) { replyResult(false, err?.message || String(err), null, 'unknown'); return; }
    if (result.mode === 'error') { replyResult(false, result.error); return; }
    replyResult(true, null, result.mode);
    if (result.mode === 'dormant') await ctx.rebuild?.().catch(() => {});
  },
};
