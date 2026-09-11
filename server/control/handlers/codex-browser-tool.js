import { writeConfig } from '../../config-store.js';

export const codexBrowserToolHandler = {
  type: 'set-codex-browser-tool-enabled',
  async handler(msg, ctx) {
    // Global (per-install) toggle, not per-session — persists in config.json so
    // every browser and every future Codex launch/resume/fork agrees. Only takes
    // effect on the NEXT launch/resume/fork of a Codex session (it sets the
    // launch env), same as trustCodexLaunchCwd. The rebuild re-broadcasts the
    // graph carrying the new flag for the settings modal.
    writeConfig({ codexBrowserToolEnabled: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
