import { readConfig, writeConfig, codexPolicyDefaults } from '../../config-store.js';

// One field of Settings › Sessions' Codex defaults at a time (`{ key, value }`),
// merged over what is stored and re-validated by codexPolicyDefaults, so a bad
// value is dropped back to the core default rather than persisted as-is.
export const codexPolicyDefaultsHandler = {
  type: 'set-codex-policy-default',
  async handler(msg, ctx) {
    const cfg = readConfig();
    const cur = codexPolicyDefaults(cfg);
    if (!Object.hasOwn(cur, msg.key)) return;
    writeConfig({ codexPolicyDefaults: codexPolicyDefaults({ codexPolicyDefaults: { ...cur, [msg.key]: msg.value } }) });
    await ctx.rebuild();
  },
};
