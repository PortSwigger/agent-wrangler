import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reduceEntry, reduceLitellm, refreshPriceCatalog, fetchLitellm, priceFor, newestClaudeName,
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

const okFetch = (body) => async () => ({ ok: true, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
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

// LiteLLM is untrusted: whatever it serves, the worst outcome is a wrong price.

test('reduceLitellm survives non-object input and rows', () => {
  for (const raw of [null, 'x', 42, [], [litellmRow('openai', 1, 1)]]) {
    assert.deepEqual(reduceLitellm(raw), { anthropic: {}, openai: {} });
  }
  const out = reduceLitellm({ a: null, b: 'str', c: [1, 2], d: 7, 'gpt-ok-1': litellmRow('openai', 1, 2) });
  assert.deepEqual(Object.keys(out.openai), ['gpt-ok-1']);
});

test('reduceLitellm drops prototype-shaped, slash-routed and odd-charactered ids', () => {
  const raw = JSON.parse(`{"__proto__": ${JSON.stringify(litellmRow('openai', 1, 1))}}`);
  Object.assign(raw, {
    constructor: litellmRow('openai', 1, 1),
    'gpt-a/b': litellmRow('openai', 1, 1),
    'gpt-<img src=x>': litellmRow('openai', 1, 1),
    'gpt-\u001b[31mred': litellmRow('openai', 1, 1),
    [`gpt-${'x'.repeat(200)}`]: litellmRow('openai', 1, 1),
    'gpt-fine-1': litellmRow('openai', 1, 1),
  });
  const out = reduceLitellm(raw);
  assert.deepEqual(Object.keys(out.openai), ['constructor', 'gpt-fine-1']);
  assert.equal(Object.getPrototypeOf(out.openai), Object.prototype);
});

test('reduceEntry rejects non-finite, negative, absurd and non-numeric rates', () => {
  for (const bad of [Infinity, -1e-6, 1e300, NaN, '0.000001', null, {}]) {
    assert.equal(reduceEntry({ input_cost_per_token: bad, output_cost_per_token: 1e-6 }), null, String(bad));
  }
  const r = reduceEntry({ input_cost_per_token: 1e-6, output_cost_per_token: 1e-6, cache_read_input_token_cost: 1e300 });
  assert.equal(r.cacheRead, 0.1, 'an absurd cache rate falls back to the default multiplier');
});

test('reduceEntry ignores a long-context tier with an unbounded threshold', () => {
  const r = reduceEntry({
    input_cost_per_token: 1e-6, output_cost_per_token: 1e-6,
    [`input_cost_per_token_above_${'9'.repeat(400)}k_tokens`]: 2e-6,
    input_cost_per_token_above_0k_tokens: 2e-6,
  });
  assert.equal(r.long, undefined);
});

test('priceFor never resolves an Object.prototype member', () => {
  _setFetchedForTest({ anthropic: {}, openai: {} });
  for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = priceFor('anthropic', m);
    assert.ok(r === null || typeof r.input === 'number', m);
  }
});

test('a hostile cache or fixture is cleaned on load, not trusted', () => {
  _setFetchedForTest({
    anthropic: {
      'claude-evil-1': { input: Infinity, output: 1, cacheRead: 1 },
      'claude-evil-2': { input: '5', output: 1, cacheRead: 1 },
      'claude-evil-3': { input: 1, output: 1, cacheRead: 1, long: { threshold: 'x', input: 1, output: 1, cacheRead: 1 } },
      'claude-ok-1': { input: 1, output: 2, cacheRead: 0.1 },
    },
    openai: 'nope',
  });
  assert.notEqual(priceFor('anthropic', 'claude-evil-1')?.input, Infinity);
  assert.notEqual(priceFor('anthropic', 'claude-evil-2')?.input, '5');
  assert.equal(priceFor('anthropic', 'claude-evil-3').long, undefined);
  assert.deepEqual(priceFor('anthropic', 'claude-ok-1'), { input: 1, output: 2, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 });
});

test('fetchLitellm refuses an oversized body', async () => {
  const big = { ok: true, headers: { get: () => String(64 * 1024 * 1024) }, text: async () => '{}' };
  await assert.rejects(fetchLitellm({ fetchImpl: async () => big }), /too large/);
  let cancelled = false;
  const chunk = new Uint8Array(8 * 1024 * 1024);
  let sent = 0;
  const streaming = { ok: true, headers: { get: () => null }, body: { getReader: () => ({
    read: async () => (sent++ < 10 ? { done: false, value: chunk } : { done: true }),
    cancel: async () => { cancelled = true; },
  }) } };
  await assert.rejects(fetchLitellm({ fetchImpl: async () => streaming }), /too large/);
  assert.ok(cancelled);
});

test('a malformed body is reported without echoing its text', async () => {
  const msgs = [];
  const orig = console.warn;
  const origErr = console.error;
  console.warn = (...a) => msgs.push(a.join(' '));
  console.error = (...a) => msgs.push(a.join(' '));
  try {
    await assert.rejects(fetchLitellm({ fetchImpl: okFetch('\u001b[2J SECRET-PAYLOAD {') }), (err) => !err.message.includes('SECRET'));
    assert.equal(await refreshPriceCatalog({ fetchImpl: okFetch('\u001b[2J SECRET-PAYLOAD {'), cachePath: tmpCache() }), false);
  } finally {
    console.warn = orig;
    console.error = origErr;
  }
  assert.ok(msgs.every((m) => !m.includes('SECRET')));
});
