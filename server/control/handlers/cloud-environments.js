import { writeConfig } from '../../config-store.js';

// A registry row is only usable if its id tells `classifyEnvironmentId` which
// launch form to build — `env_…` (Anthropic-hosted) or `ccpool_…` (self-hosted
// runner) — and only findable if it has a label to show in the dropdown. A row
// failing either is DROPPED here rather than saved-and-filtered-on-read, so a
// typo can never sit in config.json waiting to reach a launch form. (The
// config-store reader validates the same way for a hand-edited file; this is the
// write-side half of the same rule, not a substitute for it.)
function sanitize(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = String(row?.id ?? '').trim();
    const label = String(row?.label ?? '').trim();
    if (!label) continue;
    if (!id.startsWith('env_') && !id.startsWith('ccpool_')) continue;
    // Two rows with one id would make the dropdown ambiguous about which entry
    // the human picked; first spelling wins so their typing order is preserved.
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ label, id });
  }
  return out;
}

export const cloudEnvironmentsHandler = {
  type: 'cloud-environments',
  // Global (per-install) list, not per-session — persists in config.json so every
  // browser and every future cloud dispatch offers the same environments. There's
  // no API listing behind this: the human curates the rows, we only keep them.
  // The rebuild re-broadcasts the graph carrying the new registry, which is what
  // repopulates the dispatch dialog's <select>.
  //
  // `deps` is a test seam only — the router calls `handler(msg, ctx)`, so the
  // default ships. `node --test` runs against the developer's REAL
  // ~/.agent-wrangler, so a test must never reach the actual writeConfig.
  async handler(msg, ctx, deps = {}) {
    const write = deps.write || writeConfig;
    // An `environments: []` is a legitimate "I removed them all". A payload that
    // isn't an array at all is a malformed client, and wiping a hand-curated
    // registry is the one outcome worth refusing outright — so leave the stored
    // value alone and just re-broadcast what's already there.
    if (Array.isArray(msg.environments)) write({ cloudEnvironments: sanitize(msg.environments) });
    await ctx.rebuild();
  },
};
