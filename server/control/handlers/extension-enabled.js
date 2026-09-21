import { readConfig, writeConfig } from '../../config-store.js';

// The one settings toggle every extension shares: flips `extensions.<id>` in
// config.json and then makes that true of the running process. Replaces the
// per-feature `set-<feature>-enabled` handlers for anything that has migrated
// onto the extensions API. writeConfig is a shallow merge, hence the spread: a
// sibling extension's value must survive.
//
// BOTH halves of the flip land here, which is the whole of the live registry:
// turning one on re-stages its manifest and activates it (tools, handlers,
// stores, sweeps, client asset), turning it off deactivates and deregisters it,
// and `ctx.ext.changed()` is what makes the router and the browser see either.
// The manifest comes from `ctx.ext.manifests` — the loader keeps one for every
// extension it read, INCLUDING the boot-disabled ones that staged nothing, which
// is the only reason an extension that booted off can be turned on at all.
//
// The one thing still pending after this returns is an ALREADY-RUNNING agent's
// MCP tools: `--allowedTools` is baked into its launch argv, so it gains or
// loses them at its next resume. extensionFlipNote says so on the row.
//
// An activation that throws QUARANTINES exactly as boot would — a store factory
// that throws or an unsatisfiable `engines.wranglerApi` is the same bug whether
// it is hit at startup or at a toggle, and the row is where a human reads why.
export const extensionEnabledHandler = {
  type: 'extension-enabled',
  async handler(msg, ctx) {
    const known = ctx.ext.list.find((e) => e.id === msg.id);
    if (!known) throw new Error(`Unknown extension: ${String(msg.id)}`);
    const enabled = Boolean(msg.enabled);
    const cfg = readConfig();
    // The merged config as WRITTEN, threaded into staging below: `enabled` on
    // the new list entry is read from it, so an activation must not be left
    // deciding off a value this frame has already superseded.
    const next = writeConfig({ extensions: { ...(cfg.extensions || {}), [msg.id]: enabled } });
    if (enabled && !known.quarantine && !known.enabled) {
      const manifest = ctx.ext.manifests?.get(msg.id);
      // A quarantined-at-discovery entry has no manifest to re-stage — there was
      // never one to read — and a row with no manifest is nothing this toggle
      // can act on beyond the config value it already wrote.
      if (manifest) {
        try {
          // Released FIRST, even though a disabled row contributes nothing: the
          // loader claims an id in `_reg` for every entry it reads, disabled
          // ones included, so staging a boot-disabled manifest without this
          // fails as a duplicate of the row it is about to replace.
          ctx.ext.unregister(msg.id, { remove: false });
          ctx.ext.register(manifest, { cfg: next });
          ctx.ext.activate(msg.id);
        } catch (err) {
          ctx.ext.quarantine(msg.id, err);
        }
        ctx.ext.changed();
      }
    } else if (!enabled && known.enabled) {
      ctx.ext.deactivate(msg.id);
      // The row STAYS (`remove: false`): a switched-off extension still has to
      // appear in the settings list carrying the toggle that turns it back on.
      ctx.ext.unregister(msg.id, { remove: false });
      ctx.ext.changed();
    }
    await ctx.rebuild();
  },
};
