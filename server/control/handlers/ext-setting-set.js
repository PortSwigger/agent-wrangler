import { setExtensionSetting } from '../../config-store.js';

// CORE-owned, never extension-owned, and that is the whole point: an extension
// whose own handler could write `extensionSettings.<its id>` would be writing
// the record of what a human chose, which is the one thing about an extension
// that must not be the extension's to author. So this is an untagged handler —
// it receives `ctx`, not a façade — and it validates the incoming value against
// the DECLARING MANIFEST'S OWN `settings` defs (carried on the list entry by
// stageExtension), which is the only authority for what that key may hold.
//
// A control frame is browser-supplied, so nothing here trusts `type` off the
// frame: the def's type decides how `value` is read, and a value that does not
// fit is an error envelope rather than a coercion, because silently storing 0
// for "" would make the row lie about what is stored.
export const MAX_TEXT_LENGTH = 2048;

export const extSettingSetHandler = {
  type: 'ext-setting-set',
  async handler(msg, ctx) {
    const entry = ctx.ext.list.find((e) => e.id === msg.id);
    if (!entry) throw new Error(`Unknown extension: ${String(msg.id)}`);
    // A quarantined extension is contributing nothing and cannot read the value
    // back, so writing one would be storing a choice against a feature that is
    // not there. The panel disables the inputs; this refuses regardless, because
    // the client is not the authority on that.
    if (entry.quarantine) throw new Error(`Extension ${entry.id} is quarantined — fix it before changing its settings.`);
    const def = (entry.settings || []).find((s) => s.key === msg.key);
    if (!def) throw new Error(`Extension ${entry.id} has no setting "${String(msg.key)}"`);
    let value;
    if (def.type === 'toggle') value = Boolean(msg.value);
    else if (def.type === 'number') {
      if (msg.value === null || msg.value === '') value = null; // cleared
      else {
        const n = Number(msg.value);
        if (!Number.isFinite(n)) throw new Error(`Setting ${entry.id}.${def.key} must be a number`);
        value = n;
      }
    } else {
      if (typeof msg.value !== 'string') throw new Error(`Setting ${entry.id}.${def.key} must be a string`);
      if (msg.value.length > MAX_TEXT_LENGTH) throw new Error(`Setting ${entry.id}.${def.key} is too long (max ${MAX_TEXT_LENGTH} characters)`);
      value = msg.value;
    }
    setExtensionSetting(entry.id, def.key, value);
    // A rebuild and NOT ctx.ext.changed(): nothing about the REGISTRY moved. No
    // handler was registered or removed, no client asset changed, no hideTool
    // veto appeared — and changed() re-broadcasts the client manifest, which
    // would make every tab re-evaluate its extension modules for a value edit.
    // The graph is the only thing that has to carry the new value back (see
    // extensionsForGraph).
    await ctx.rebuild();
  },
};
