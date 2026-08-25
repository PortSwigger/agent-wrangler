import { writeConfig } from '../../config-store.js';

export const chatViewDefaultHandler = {
  type: 'set-chat-view-default',
  async handler(msg, ctx) {
    // Global (per-install) default, not per-session — persists in config.json so
    // every browser agrees. The rebuild re-broadcasts the graph carrying the new
    // flag, which is what a card with no explicit override reads.
    writeConfig({ chatViewDefault: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
