import { writeConfig } from '../../config-store.js';

export const mailWakesDormantHandler = {
  type: 'set-mail-wakes-dormant',
  async handler(msg, ctx) {
    writeConfig({ mailWakesDormant: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
