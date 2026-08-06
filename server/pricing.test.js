import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, codexCostUsd } from './pricing.js';

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

test('claude costUsd unchanged for opus (1M input = $5)', () => {
  const usd = costUsd({ opus: { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  assert.equal(usd, 5);
});

test('claude costUsd prices fable above opus (1M input = $10)', () => {
  const usd = costUsd({ 'claude-fable-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  assert.equal(usd, 10);
});
