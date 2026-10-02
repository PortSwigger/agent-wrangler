import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
import { costUsd, costUsdByType, codexCostUsd, codexCostUsdByType } from './pricing.js';
import { _setFetchedForTest } from './price-catalog.js';

// Exact $ are asserted against fixture ids layered over the snapshot, so a real
// upstream reprice never breaks these — only the arithmetic can.
const CLAUDE_FIXTURE = {
  'claude-testfam-9': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
};
const OPENAI_FIXTURE = {
  'gpt-test-1': { input: 2, output: 10, cacheRead: 0.2, long: { threshold: 272_000, input: 4, output: 15, cacheRead: 0.4 } },
  'gpt-test-1-mini': { input: 0.75, output: 4.5, cacheRead: 0.075 },
};
afterEach(() => _setFetchedForTest(null));
const withFixtures = () => _setFetchedForTest({ anthropic: CLAUDE_FIXTURE, openai: OPENAI_FIXTURE });
const ONE = { input: 1_000_000, output: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 };

test('codexCostUsd prices gpt-5.5-codex tokens', () => {
  const usd = codexCostUsd({ 'gpt-5.5-codex': { input: 1_000_000, output: 1_000_000, cacheRead: 0 } });
  assert.ok(usd > 0);
});

test('codexCostUsd prices gpt-5.6-sol/terra/luna tokens', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const usd = codexCostUsd({ [model]: { input: 1_000_000, output: 1_000_000, cacheRead: 0 } });
    assert.ok(usd > 0, `${model} should have a positive cost`);
  }
});

test('codexCostUsd unknown model still returns a number (default rate)', () => {
  const usd = codexCostUsd({ 'mystery-model': { input: 1_000_000, output: 0, cacheRead: 0 } });
  assert.equal(typeof usd, 'number');
});

test('codexCostUsd bills a model at its short-context rate', () => {
  withFixtures();
  const usd = codexCostUsd({ 'gpt-test-1': { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 } });
  assert.equal(usd, 2 + 10 + 0.2);
});

test('codexCostUsd bills the long-context share at the long rate', () => {
  withFixtures();
  // 3M input / 1M output / 1M cached, of which 1M / 0.5M / 1M came from long requests.
  const totals = { 'gpt-test-1': {
    input: 3_000_000, output: 1_000_000, cacheRead: 1_000_000,
    long: { input: 1_000_000, output: 500_000, cacheRead: 1_000_000 },
  } };
  const byType = codexCostUsdByType(totals);
  assert.equal(byType.input, 2 * 2 + 4);
  assert.equal(byType.output, 0.5 * 10 + 0.5 * 15);
  assert.equal(byType.cacheRead, 0.4);
  assert.equal(codexCostUsd(totals), byType.input + byType.output + byType.cacheRead);
});

test('codexCostUsd falls back to the short rate for a model with no long rate', () => {
  withFixtures();
  const usd = codexCostUsd({ 'gpt-test-1-mini': { input: 1_000_000, output: 0, cacheRead: 0, long: { input: 1_000_000, output: 0, cacheRead: 0 } } });
  assert.equal(usd, 0.75);
});

test('claude costUsd bills every token type at its own rate', () => {
  withFixtures();
  assert.equal(costUsd({ 'claude-testfam-9': ONE }), 4 + 20 + 5 + 8 + 0.2);
  const byType = costUsdByType({ 'claude-testfam-9': ONE });
  assert.deepEqual(byType, { input: 4, output: 20, cacheWrite: 13, cacheRead: 0.2 });
});

test('claude costUsd resolves dated and suffixed ids to their base model', () => {
  withFixtures();
  assert.equal(costUsd({ 'claude-testfam-9-20270101': ONE }), costUsd({ 'claude-testfam-9': ONE }));
  assert.equal(costUsd({ 'claude-testfam-9 (advisor)': ONE }), costUsd({ 'claude-testfam-9': ONE }));
});

test('claude costUsd prices an unlisted model of a known family as its newest sibling', () => {
  withFixtures();
  assert.equal(costUsd({ 'claude-testfam-10': ONE }), costUsd({ 'claude-testfam-9': ONE }));
});

test('claude costUsd prices a wholly unknown model as the newest Opus', () => {
  assert.equal(costUsd({ opus: ONE }), costUsd({ 'claude-opus': ONE }));
  assert.ok(costUsd({ 'mystery-model': ONE }) > 0);
  assert.ok(costUsd({ 'mystery-model': ONE }) < costUsd({ 'claude-fable-5': ONE }), 'never billed at the top tier');
});

test('claude costUsd prices a bare Claude Code alias as its family', () => {
  withFixtures();
  assert.equal(costUsd({ testfam: ONE }), costUsd({ 'claude-testfam-9': ONE }));
  assert.equal(costUsd({ 'testfam[1m]': ONE }), costUsd({ 'claude-testfam-9': ONE }));
});

// Smoke tests on the shipped snapshot: relative, so a real reprice doesn't break them.
test('snapshot prices fable above opus and opus 5.5 below older opus', () => {
  assert.ok(costUsd({ 'claude-fable-5': ONE }) > costUsd({ 'claude-opus-5': ONE }));
  assert.ok(costUsd({ 'claude-opus-5-5': ONE }) < costUsd({ 'claude-opus-5': ONE }));
});

test('snapshot distinguishes fable 5.1 cache reads from fable 5', () => {
  const reads = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000 };
  assert.ok(costUsd({ 'claude-fable-5-1': reads }) < costUsd({ 'claude-fable-5': reads }));
});
