import { writeConfig } from '../../config-store.js';

export const trustCodexLaunchCwdHandler = {
  type: 'set-trust-codex-launch-cwd',
  async handler(msg, ctx) {
    // Global (per-install) toggle, not per-session — persists in config.json so
    // every browser and every future Codex launch/resume/fork agrees. The rebuild
    // re-broadcasts the graph carrying the new flag for the settings modal.
    writeConfig({ trustCodexLaunchCwd: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
