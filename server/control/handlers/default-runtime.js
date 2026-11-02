import { writeConfig } from '../../config-store.js';

export const defaultRuntimeHandler = {
  type: 'set-default-runtime',
  async handler(msg, ctx) {
    writeConfig({ defaultRuntime: typeof msg.runtime === 'string' && msg.runtime.trim() ? msg.runtime.trim() : 'local' });
    await ctx.rebuild();
  },
};
