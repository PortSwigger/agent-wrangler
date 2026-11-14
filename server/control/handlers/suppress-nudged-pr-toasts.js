import { writeConfig } from '../../config-store.js';

export const suppressNudgedPrToastsHandler = {
  type: 'set-suppress-nudged-pr-toasts',
  async handler(msg, ctx) {
    writeConfig({ suppressNudgedPrToasts: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
