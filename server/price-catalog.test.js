import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reduceEntry, reduceLitellm, refreshPriceCatalog, priceFor, newestClaudeName,
  priceCatalogVersion, onPriceCatalogChange, _setFetchedForTest,
} from './price-catalog.js';

afterEach(() => _setFetchedForTest(null));

const litellmRow = (provider, input, output, extra = {}) => ({
  litellm_provider: provider, mode: 'chat', input_cost_per_token: input / 1e6, output_cost_per_token: output / 1e6, ...extra,
});

// Enough rows to clear the "truncated upstream" guard.
function plausibleUpstream(extra = {}) {
  const raw = {};
  for (let i = 0; i < 12; i += 1) raw[`gpt-filler-${i}`] = litellmRow('openai', 1, 2);
  return { ...raw, ...extra };
}

const okFetch = (body) => async () => ({ ok: true, json: async () => body });
const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-price-')), 'price-catalog.json');

test('reduceEntry converts per-token rates to per-1M, rounding float noise away', () => {
  const r = reduceEntry({
    input_cost_per_token: 4e-6, output_cost_per_token: 2e-5,
    cache_creation_input_token_cost: 5e-6, cache_creation_input_token_cost_above_1hr: 8e-6, cache_read_input_token_cost: 2e-7,
  });
  assert.deepEqual(r, { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 });
});

test('reduceEntry fills missing cache rates with the standard multipliers', () => {
  const r = reduceEntry({ input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 });
  assert.deepEqual(r, { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 });
});

test('reduceEntry carries a long-context tier with its threshold', () => {
  const r = reduceEntry({
    input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2e-7,
    input_cost_per_token_above_272k_tokens: 4e-6, output_cost_per_token_above_272k_tokens: 1.5e-5,
    cache_read_input_token_cost_above_272k_tokens: 4e-7,
  });
  assert.deepEqual(r.long, { threshold: 272_000, input: 4, output: 15, cacheRead: 0.4 });
});

test('reduceEntry skips a row with no token prices', () => {
  assert.equal(reduceEntry({ output_cost_per_token: 1e-5 }), null);
});

test('reduceLitellm keeps first-party anthropic/openai chat rows only', () => {
  const out = reduceLitellm({
    'claude-x-1': litellmRow('anthropic', 1, 5),
    'gpt-x-1': litellmRow('openai', 1, 5),
    'bedrock/claude-x-1': litellmRow('anthropic', 9, 9),
    'us.anthropic.claude-x-1': litellmRow('bedrock_converse', 9, 9),
    'text-embedding-x': { ...litellmRow('openai', 1, 0), mode: 'embedding' },
    sample_spec: { mode: 'chat' },
  });
  assert.deepEqual(Object.keys(out.anthropic), ['claude-x-1']);
  assert.deepEqual(Object.keys(out.openai), ['gpt-x-1']);
});

test('refreshPriceCatalog adopts a fetched model, persists it, and notifies', async () => {
  const cachePath = tmpCache();
  const before = priceCatalogVersion();
  let notified = 0;
  const off = onPriceCatalogChange(() => { notified += 1; });
  const changed = await refreshPriceCatalog({
    fetchImpl: okFetch(plausibleUpstream({ 'claude-newfam-3': litellmRow('anthropic', 7, 35) })),
    cachePath,
  });
  off();
  assert.equal(changed, true);
  assert.equal(notified, 1);
  assert.ok(priceCatalogVersion() > before);
  assert.equal(priceFor('anthropic', 'claude-newfam-3').input, 7);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).anthropic['claude-newfam-3'].output, 35);
});

test('a fetch never drops a snapshot row, so retired models keep their price', async () => {
  const snapshotRate = priceFor('anthropic', 'claude-haiku-4-5');
  assert.ok(snapshotRate, 'snapshot should carry haiku 4.5');
  await refreshPriceCatalog({ fetchImpl: okFetch(plausibleUpstream()), cachePath: tmpCache() });
  assert.deepEqual(priceFor('anthropic', 'claude-haiku-4-5'), snapshotRate);
});

test('refreshPriceCatalog keeps the current catalog on a failed or truncated fetch', async () => {
  _setFetchedForTest({ anthropic: { 'claude-keep-1': { input: 3, output: 3, cacheWrite5m: 3, cacheWrite1h: 3, cacheRead: 3 } }, openai: {} });
  assert.equal(await refreshPriceCatalog({ fetchImpl: async () => { throw new Error('offline'); }, cachePath: tmpCache() }), false);
  assert.equal(await refreshPriceCatalog({ fetchImpl: async () => ({ ok: false, status: 503 }), cachePath: tmpCache() }), false);
  assert.equal(await refreshPriceCatalog({ fetchImpl: okFetch({ 'gpt-one': litellmRow('openai', 1, 1) }), cachePath: tmpCache() }), false);
  assert.equal(priceFor('anthropic', 'claude-keep-1').input, 3);
});

test('newestClaudeName names the highest version of a family', () => {
  const rate = { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 };
  _setFetchedForTest({ anthropic: { 'claude-zeta-3': rate, 'claude-zeta-3-2': rate, 'claude-zeta-2-9-20260101': rate }, openai: {} });
  assert.equal(newestClaudeName('zeta'), 'Zeta 3.2');
  assert.equal(newestClaudeName('nonesuch'), null);
});

test('priceFor prefers the longest matching id', () => {
  _setFetchedForTest({ anthropic: {}, openai: {
    'gpt-q-1': { input: 2, output: 2, cacheRead: 0 },
    'gpt-q-1-mini': { input: 1, output: 1, cacheRead: 0 },
  } });
  assert.equal(priceFor('openai', 'gpt-q-1-mini-2027-01-01').input, 1);
  assert.equal(priceFor('openai', 'gpt-q-1-codex').input, 2);
  assert.equal(priceFor('openai', 'gpt-q-11'), priceFor('openai', 'gpt-q-1'), 'gpt-q-11 is a sibling, not a gpt-q-1 variant');
});
