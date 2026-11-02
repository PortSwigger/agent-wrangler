import { writeConfig } from '../../config-store.js';

export const trustClaudeLaunchCwdHandler = {
  type: 'set-trust-claude-launch-cwd',
  async handler(msg, ctx) {
    // Global (per-install) toggle, persisted in config.json like the Codex one.
    writeConfig({ trustClaudeLaunchCwd: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
