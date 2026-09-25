import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, codexCostUsd, codexCostUsdByType } from './pricing.js';

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

test('codexCostUsd bills gpt-5.6-sol at its Standard short-context rate', () => {
  const usd = codexCostUsd({ 'gpt-5.6-sol': { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 } });
  assert.equal(usd, 4 + 20 + 0.4);
});

test('codexCostUsd bills the long-context share at the long rate', () => {
  // 3M input / 1M output / 1M cached, of which 1M / 0.5M / 1M came from long requests.
  const totals = { 'gpt-6-sol': {
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
  const usd = codexCostUsd({ 'gpt-5.4-mini': { input: 1_000_000, output: 0, cacheRead: 0, long: { input: 1_000_000, output: 0, cacheRead: 0 } } });
  assert.equal(usd, 0.75);
});

test('claude costUsd unchanged for opus (1M input = $5)', () => {
  const usd = costUsd({ opus: { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  assert.equal(usd, 5);
});

test('claude costUsd prices fable above opus (1M input = $10)', () => {
  const usd = costUsd({ 'claude-fable-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  assert.equal(usd, 10);
});

test('claude costUsd prices opus 5.5 below older opus', () => {
  const one = { input: 1_000_000, output: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 };
  assert.equal(costUsd({ 'claude-opus-5-5': one }), 4 + 20 + 5 + 8 + 0.2);
  assert.equal(costUsd({ 'claude-opus-5': one }), 5 + 25 + 6.25 + 10 + 0.5);
});

test('claude costUsd prices sonnet 5 below sonnet 4.x', () => {
  const one = { input: 1_000_000, output: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  assert.equal(costUsd({ 'claude-sonnet-5': one }), 2 + 10);
  assert.equal(costUsd({ 'claude-sonnet-4-5-20250929': one }), 3 + 15);
});

test('claude costUsd prices fable 5.1 cache reads below fable 5', () => {
  const one = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000 };
  assert.equal(costUsd({ 'claude-fable-5-1': one }), 0.25);
  assert.equal(costUsd({ 'claude-fable-5': one }), 1);
});
