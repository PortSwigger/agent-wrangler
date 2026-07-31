import { deliverMessage } from '../../message-delivery.js';

// Human-driven counterpart to the send_message MCP tool — same routing (live: paste
// into the pane; dormant: wake it and deliver; archived: refuse), via the shared
// deliverMessage primitive so the two paths can't drift.
export const messageHandler = {
  type: 'message',
  async handler(msg, ctx) {
    if (!msg.text) { ctx.reply({ type: 'error', message: 'No message text given.' }); return; }
    const result = await deliverMessage(msg.sessionId, msg.text, ctx);
    if (result.mode === 'error') { ctx.reply({ type: 'error', message: result.error }); return; }
    if (result.mode === 'dormant') await ctx.rebuild?.();
  },
};
