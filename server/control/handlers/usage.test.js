import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageHandler, _resetUsageCache } from './usage.js';

// A minimal fake scan (the shape scanAllDaily returns) so the handler is tested in
// isolation from disk — the engine itself is covered by usage-report.test.js.
function fakeScan() {
  return {
    generatedAt: '2026-07-16T00:00:00.000Z',
    sessions: [
      { file: 'f1', owner: true, task: { key: 't1', name: 'Alpha' },
        days: { [new Date().toISOString().slice(0, 10)]: { usd: 1, estimatedUsd: 0, subAgentUsd: 0, tokens: { input: 10, output: 20, cacheWrite: 0, cacheRead: 0 } } } },
    ],
  };
}

test('replies with a rolled-up usage payload for the requested granularity', async () => {
  _resetUsageCache();
  const replies = [];
  const ctx = { reply: (o) => replies.push(o), scanUsage: async () => fakeScan() };
  await usageHandler.handler({ type: 'usage', granularity: 'week' }, ctx);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].type, 'usage');
  assert.equal(replies[0].granularity, 'week');
  assert.deepEqual(replies[0].tasks.map((t) => t.name), ['Alpha']);
});

test('defaults an unknown granularity to day', async () => {
  _resetUsageCache();
  const replies = [];
  const ctx = { reply: (o) => replies.push(o), scanUsage: async () => fakeScan() };
  await usageHandler.handler({ type: 'usage', granularity: 'annual' }, ctx);
  assert.equal(replies[0].granularity, 'day');
});

test('caches the disk scan across requests (scan runs once within the TTL)', async () => {
  _resetUsageCache();
  let scans = 0;
  const ctx = { reply: () => {}, scanUsage: async () => { scans += 1; return fakeScan(); } };
  await usageHandler.handler({ granularity: 'day' }, ctx);
  await usageHandler.handler({ granularity: 'week' }, ctx);
  await usageHandler.handler({ granularity: 'month' }, ctx);
  assert.equal(scans, 1, 'three requests, one scan — a granularity toggle re-rolls the cache');
});
