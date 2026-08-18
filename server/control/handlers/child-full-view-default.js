import { writeConfig } from '../../config-store.js';

export const childFullViewDefaultHandler = {
  type: 'set-child-full-view-default',
  async handler(msg, ctx) {
    // Global (per-install) toggle, not per-session — persists in config.json so
    // every browser and every future launch agrees. Only ever the FALLBACK for a
    // child with no explicit per-session override (see setChildFullView). The
    // rebuild re-broadcasts the graph carrying the new flag.
    writeConfig({ childFullViewByDefault: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
