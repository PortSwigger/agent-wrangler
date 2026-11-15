import { writeConfig } from '../../config-store.js';

export const defaultRuntimeHandler = {
  type: 'set-default-runtime',
  async handler(msg, ctx) {
    writeConfig({ defaultRuntime: typeof msg.runtime === 'string' && msg.runtime.trim() ? msg.runtime.trim() : 'local' });
    await ctx.rebuild();
  },
};

export const deckRuntimesHandler = {
  type: 'set-deck-runtimes',
  async handler(msg, ctx) {
    const raw = Array.isArray(msg.runtimes) ? msg.runtimes : typeof msg.runtimes === 'string' ? msg.runtimes.split(',') : [];
    const ids = [...new Set(raw.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean))];
    writeConfig({ deckRuntimes: ids.length ? ids : undefined });
    await ctx.rebuild();
  },
};
