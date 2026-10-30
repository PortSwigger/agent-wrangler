import { writeConfig } from '../../config-store.js';

export const prModelFooterHandler = {
  type: 'set-pr-model-footer',
  async handler(msg, ctx) {
    writeConfig({ prModelFooter: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
