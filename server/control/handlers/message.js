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
    const agent = ctx.sessionFromGraph?.(msg.sessionId)?.agent
      ?? ctx.sessionManager?.entryFor?.(msg.sessionId)?.agent;
    const imagePaths = resolvePasteNames(msg.sessionId, agent, msg.imageNames);
    // An image on its own is a complete prompt (the TUI submits the bare
    // `[Image #1]`), so empty text is only an error when nothing is attached
    // either.
    if (!msg.text && !imagePaths.length) { ctx.reply({ type: 'error', message: 'No message text given.' }); return; }
    const result = await deliverMessage(msg.sessionId, msg.text || '', ctx, { imagePaths });
    if (result.mode === 'error') { ctx.reply({ type: 'error', message: result.error }); return; }
    if (result.mode === 'dormant') await ctx.rebuild?.();
  },
};
