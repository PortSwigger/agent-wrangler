import { writeConfig } from '../../config-store.js';

export const taskMemoryEnabledHandler = {
  type: 'set-task-memory-enabled',
  async handler(msg, ctx) {
    // Global (per-install) toggle, not per-session — persists in config.json so
    // every browser and every future launch agrees. The rebuild re-broadcasts the
    // graph carrying the new flag, which is what hides/shows the tile buttons.
    writeConfig({ taskMemoryEnabled: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
