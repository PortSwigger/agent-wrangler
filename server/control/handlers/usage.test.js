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

test('a range change still triggers only one scan (re-rolls the cached scan in memory)', async () => {
  _resetUsageCache();
  let scans = 0;
  const ctx = { reply: () => {}, scanUsage: async () => { scans += 1; return fakeScan(); } };
  await usageHandler.handler({ type: 'usage', granularity: 'day', start: null, end: null }, ctx);
  await usageHandler.handler({ type: 'usage', granularity: 'day', start: '2026-01-01', end: '2026-01-31' }, ctx);
  await usageHandler.handler({ type: 'usage', granularity: 'week', start: '2026-06-01', end: null }, ctx);
  assert.equal(scans, 1, 'the scan cache is deliberately not keyed on the range');
});

test('well-formed day keys reach rollup and are reflected in the reply\'s snapped range', async () => {
  _resetUsageCache();
  const replies = [];
  const ctx = { reply: (o) => replies.push(o), scanUsage: async () => fakeScan() };
  await usageHandler.handler({ type: 'usage', granularity: 'month', start: '2026-07-03', end: '2026-08-20' }, ctx);
  const r = replies[0];
  assert.equal(new Date(r.rangeStart).toISOString(), '2026-07-01T00:00:00.000Z', 'snapped to the whole month');
  assert.equal(new Date(r.rangeEnd).toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(r.reqStart, '2026-07-03');
  assert.equal(r.reqEnd, '2026-08-20');
});

test('malformed input (bad shape, invalid date, wrong type) is dropped to unbounded, never throws', async () => {
  _resetUsageCache();
  const cases = ['2026-13-40', 'nope', 20260101, { y: 2026 }, undefined, null];
  for (const bad of cases) {
    const replies = [];
    const ctx = { reply: (o) => replies.push(o), scanUsage: async () => fakeScan() };
    await assert.doesNotReject(usageHandler.handler({ type: 'usage', granularity: 'day', start: bad, end: bad }, ctx));
    assert.equal(replies.length, 1, `a reply is still produced for ${JSON.stringify(bad)}`);
    assert.equal(replies[0].reqStart, null);
    assert.equal(replies[0].reqEnd, null);
  }
});

test('a reversed pair is swapped, not rejected, and the swap is what reqStart/reqEnd echo', async () => {
  _resetUsageCache();
  const replies = [];
  const ctx = { reply: (o) => replies.push(o), scanUsage: async () => fakeScan() };
  await usageHandler.handler({ type: 'usage', granularity: 'day', start: '2026-08-20', end: '2026-07-03' }, ctx);
  assert.equal(replies[0].reqStart, '2026-07-03');
  assert.equal(replies[0].reqEnd, '2026-08-20');
});
