import { readConfig, writeConfig } from '../../config-store.js';

// The one settings toggle every extension shares: flips `extensions.<id>` in
// config.json. Replaces the per-feature `set-<feature>-enabled` handlers for
// anything that has migrated onto the extensions API. Nothing flips LIVE — the
// loader fixed tools/handlers/skills at boot, so the rebuild only re-emits
// `graph.extensions[].enabled` (which the toggle reads back) and everything else
// changes at the next restart, which the manifest's help text says. writeConfig
// is a shallow merge, hence the spread: a sibling extension's value must survive.
export const extensionEnabledHandler = {
  type: 'extension-enabled',
  async handler(msg, ctx) {
    const known = ctx.ext.list.find((e) => e.id === msg.id);
    if (!known) throw new Error(`Unknown extension: ${String(msg.id)}`);
    const cfg = readConfig();
    writeConfig({ extensions: { ...(cfg.extensions || {}), [msg.id]: Boolean(msg.enabled) } });
    await ctx.rebuild();
  },
};
