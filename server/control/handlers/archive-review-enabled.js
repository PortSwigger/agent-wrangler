import { writeConfig } from '../../config-store.js';

export const archiveReviewEnabledHandler = {
  type: 'set-archive-review-enabled',
  async handler(msg, ctx) {
    // Global (per-install) toggle, not per-session — persists in config.json so
    // every browser and every future archive agrees. The rebuild re-broadcasts
    // the graph carrying the new flag for the settings modal.
    writeConfig({ archiveReviewEnabled: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
