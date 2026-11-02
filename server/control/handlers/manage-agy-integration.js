import { refreshAgyModels } from '../../agents/agy-catalog.js';
import { writeConfig } from '../../config-store.js';
import { syncAgyPlugin } from '../../agy-plugin.js';
export const manageAgyIntegrationHandler = {
  type: 'set-manage-agy-integration',
  async handler(msg, ctx) {
    writeConfig({ manageAgyIntegration: msg.enabled === true });
    const state = await syncAgyPlugin();
    if (state.ready) await refreshAgyModels();
    await ctx.rebuild();
    ctx.broadcastAgents?.();
  },
};
export const trustAgyLaunchCwdHandler = {
  type: 'set-trust-agy-launch-cwd',
  async handler(msg, ctx) {
    writeConfig({ trustAgyLaunchCwd: msg.enabled === true });
    await ctx.rebuild();
  },
};
