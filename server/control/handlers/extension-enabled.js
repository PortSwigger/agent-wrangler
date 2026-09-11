import { readConfig, writeConfig } from '../../config-store.js';

// The one settings toggle every extension shares: flips `extensions.<id>` in
// config.json. Replaces the per-feature `set-<feature>-enabled` handlers for
// anything that has migrated onto the extensions API. The rebuild is what makes
// the toggle mean something now rather than at the next restart: index.js reads
// `graph.extensions[].enabled` LIVE, so the client unmounts (or re-mounts) the
// extension's slot contributions on the next tick. Only the UI moves — the
// loader fixed tools/handlers/skills/stores at boot, so an agent's MCP tools
// follow at its next relaunch and an extension that booted OFF cannot be turned
// on live at all, both of which the manifest's help text says. writeConfig is a
// shallow merge, hence the spread: a sibling extension's value must survive.
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
