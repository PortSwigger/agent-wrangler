import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellValue, dimensionMap, rankMembers, displaySlots, bucketSegments, niceTicks, fmtTokens, fmtUsd } from './usage-data.js';

const CATS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const OTHER = 'cO';
const cell = (usd, tok = {}) => ({ usd, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, ...tok } });

test('cellValue reads $ and sums all token types for Tokens', () => {
  const c = cell(1.5, { input: 10, output: 20, cacheWrite: 3, cacheRead: 7 });
  assert.equal(cellValue(c, 'usd'), 1.5);
  assert.equal(cellValue(c, 'tokens'), 40, 'tokens = input+output+cacheWrite+cacheRead');
  assert.equal(cellValue(undefined, 'usd'), 0, 'missing cell is zero');
  // A Token-type cell fills only its own slot, so the sum is that type's count.
  assert.equal(cellValue(cell(0.2, { cacheRead: 500 }), 'tokens'), 500);
});

test('dimensionMap selects the active slice map', () => {
  const b = { byTask: { t: 1 }, byModel: { m: 2 }, byType: { input: 3 } };
  assert.deepEqual(dimensionMap(b, 'task'), { t: 1 });
  assert.deepEqual(dimensionMap(b, 'model'), { m: 2 });
  assert.deepEqual(dimensionMap(b, 'type'), { input: 3 });
  assert.deepEqual(dimensionMap(undefined, 'task'), {});
});

test('rankMembers orders by the active metric, not always $', () => {
  const members = [{ key: 'input', name: 'Input' }, { key: 'cacheRead', name: 'Cache read' }];
  const buckets = [
    { byType: { input: cell(9, { input: 100 }), cacheRead: cell(1, { cacheRead: 900 }) } },
  ];
  // In $ input dominates; in tokens cache-read dominates — ranking flips with the metric.
  assert.deepEqual(rankMembers(members, buckets, 'usd', 'type').map((m) => m.key), ['input', 'cacheRead']);
  assert.deepEqual(rankMembers(members, buckets, 'tokens', 'type').map((m) => m.key), ['cacheRead', 'input']);
});

test('displaySlots colours the first six members and folds the rest', () => {
  const members = Array.from({ length: 8 }, (_, i) => ({ key: `t${i}`, name: `T${i}` }));
  const { shown, foldedKeys } = displaySlots(members, CATS);
  assert.equal(shown.length, 6);
  assert.deepEqual(shown.map((s) => s.colorVar), CATS);
  assert.deepEqual(foldedKeys, ['t6', 't7']);
});

test('displaySlots handles a short/empty member list (fixed dims never fold)', () => {
  assert.deepEqual(displaySlots([], CATS), { shown: [], foldedKeys: [] });
  assert.equal(displaySlots([{ key: 'a', name: 'A' }], CATS).shown.length, 1);
  // The four fixed token types fit in six slots, so nothing folds.
  const types = ['input', 'output', 'cacheWrite', 'cacheRead'].map((k) => ({ key: k, name: k }));
  assert.deepEqual(displaySlots(types, CATS).foldedKeys, []);
});

test('bucketSegments stacks shown members and folds the rest into Other', () => {
  const members = Array.from({ length: 7 }, (_, i) => ({ key: `t${i}`, name: `T${i}` }));
  const slots = displaySlots(members, CATS);
  const bucket = { byTask: {
    t0: cell(5), t1: cell(0), t3: cell(2), t6: cell(4), // t6 is folded
  } };
  const segs = bucketSegments(bucket, slots, 'usd', null, OTHER, 'task');
  // zero-value member (t1) dropped; Other present for the folded t6.
  assert.deepEqual(segs.map((s) => s.key), ['t0', 't3', '__other']);
  const other = segs.find((s) => s.other);
  assert.equal(other.value, 4);
  assert.equal(other.colorVar, OTHER);
  assert.equal(other.key, '__other');
});

test('a real member named __other is a normal segment, not the fold aggregate', () => {
  // A model/task id can literally equal the fold sentinel; the fold is flagged with
  // `other`, so the real member stays an ordinary (filterable) segment.
  const members = [{ key: '__other', name: '__other' }];
  const slots = displaySlots(members, CATS);
  const segs = bucketSegments({ byModel: { __other: cell(5) } }, slots, 'usd', null, OTHER, 'model');
  assert.deepEqual(segs.map((s) => s.key), ['__other']);
  assert.equal(segs[0].other, undefined, 'the real member is not marked as the fold');
});

test('bucketSegments reads the active dimension map', () => {
  const members = [{ key: 'opus-4', name: 'opus-4' }, { key: 'sonnet-4', name: 'sonnet-4' }];
  const slots = displaySlots(members, CATS);
  const bucket = { byModel: { 'opus-4': cell(5), 'sonnet-4': cell(3) } };
  const segs = bucketSegments(bucket, slots, 'usd', null, OTHER, 'model');
  assert.deepEqual(segs.map((s) => s.key), ['opus-4', 'sonnet-4']);
  assert.deepEqual(segs.map((s) => s.value), [5, 3]);
});

test('bucketSegments under a filter shows exactly that member, no Other', () => {
  const members = Array.from({ length: 7 }, (_, i) => ({ key: `t${i}`, name: `T${i}` }));
  const slots = displaySlots(members, CATS);
  const bucket = { byTask: { t0: cell(5), t3: cell(2), t6: cell(4) } };
  const segs = bucketSegments(bucket, slots, 'usd', 't3', OTHER, 'task');
  assert.deepEqual(segs.map((s) => s.key), ['t3']);
});

test('niceTicks always reaches at least the max', () => {
  for (const max of [0.0597, 1, 7, 42, 999, 1234567]) {
    const ticks = niceTicks(max);
    assert.equal(ticks[0], 0);
    assert.ok(ticks[ticks.length - 1] >= max, `top tick ${ticks.at(-1)} covers ${max}`);
    assert.ok(ticks.length <= 6, 'stays to a readable handful of ticks');
  }
  assert.deepEqual(niceTicks(0), [0]);
});

test('token/usd formatters', () => {
  assert.equal(fmtUsd(12.3), '$12.30');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(1500), '2k');
  assert.equal(fmtTokens(2_400_000), '2.4M');
});
