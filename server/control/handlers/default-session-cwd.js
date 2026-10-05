import { writeConfig } from '../../config-store.js';

export const defaultSessionCwdHandler = {
  type: 'set-default-session-cwd',
  async handler(msg, ctx) {
    writeConfig({ defaultSessionCwd: typeof msg.cwd === 'string' ? msg.cwd.trim() : '' });
    await ctx.rebuild();
  },
};
