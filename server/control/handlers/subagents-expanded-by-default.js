import { writeConfig } from '../../config-store.js';

export const subagentsExpandedByDefaultHandler = {
  type: 'set-subagents-expanded-by-default',
  async handler(msg, ctx) {
    // Global (per-install) toggle, not per-session — persists in config.json so
    // every browser and every future launch agrees. The rebuild re-broadcasts the
    // graph carrying the new flag, which is what the board's default expand/collapse
    // state reads.
    writeConfig({ subagentsExpandedByDefault: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
