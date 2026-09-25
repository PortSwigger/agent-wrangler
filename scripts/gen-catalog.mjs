#!/usr/bin/env node
// Refresh the bundled model/price snapshots — the offline fallbacks behind the
// live catalogs (server/price-catalog.js, server/agents/codex-catalog.js) — then
// regenerate the spawn-session skill's model table from them. A running server
// never needs this: it fetches both itself. Run it now and then so a fresh
// install starts close to current.
//
//   npm run gen:catalog                      # LiteLLM over the network + local `codex`
//   npm run gen:catalog -- --litellm FILE    # a downloaded LiteLLM JSON instead
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LITELLM_URL, reduceLitellm } from '../server/price-catalog.js';
import { reduceCodexCatalog } from '../server/agents/codex-catalog.js';

const PRICE_SNAPSHOT = new URL('../server/price-catalog.snapshot.json', import.meta.url);
const CODEX_SNAPSHOT = new URL('../server/agents/codex-models.snapshot.json', import.meta.url);

const i = process.argv.indexOf('--litellm');
const raw = i > 0
  ? JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'))
  : await (await fetch(LITELLM_URL)).json();
const prices = reduceLitellm(raw);
// Sorted keys so a refresh diffs as the rows that actually changed.
const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
fs.writeFileSync(PRICE_SNAPSHOT, `${JSON.stringify({
  source: LITELLM_URL,
  anthropic: sorted(prices.anthropic),
  openai: sorted(prices.openai),
}, null, 1)}\n`);
console.log(`price snapshot: ${Object.keys(prices.anthropic).length} anthropic, ${Object.keys(prices.openai).length} openai rows`);

try {
  const out = execFileSync('codex', ['debug', 'models'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const models = reduceCodexCatalog(JSON.parse(out));
  fs.writeFileSync(CODEX_SNAPSHOT, `${JSON.stringify({ models }, null, 1)}\n`);
  console.log(`codex snapshot: ${models.filter((m) => m.visibility === 'list').length} listed models`);
} catch (err) {
  console.warn(`codex snapshot NOT refreshed (${err.message.split('\n')[0]}) — kept the existing one`);
}

// Fresh process for the skill table, so it reads the snapshots just written.
execFileSync(process.execPath, [new URL('./gen-skill-models.mjs', import.meta.url).pathname], { stdio: 'inherit' });
