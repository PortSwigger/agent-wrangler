import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketMetaFor, buildBrowseBuckets, filterTasksByName, rowTitle } from './search-browse.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// A fixed "now" so elapsed-time buckets are deterministic.
const NOW = 1_000 * DAY;

function group(id, agoMs, extra = {}) {
  return { sessionId: id, cwd: '/x', lastActivity: NOW - agoMs, ...extra };
}
function task(id, name, agoMs) {
  return { id, name, archivedAt: NOW - agoMs };
}

test('bucketMetaFor covers the fixed recent buckets, inclusive at the boundaries', () => {
  assert.equal(bucketMetaFor(1 * HOUR).label, 'Last 4 hours');
  assert.equal(bucketMetaFor(4 * HOUR).label, 'Last 4 hours');
  assert.equal(bucketMetaFor(5 * HOUR).label, 'Last day');
  assert.equal(bucketMetaFor(DAY).label, 'Last day');
  assert.equal(bucketMetaFor(30 * HOUR).label, 'Last 2 days');
  assert.equal(bucketMetaFor(2 * DAY).label, 'Last 2 days');
  assert.equal(bucketMetaFor(5 * DAY).label, 'Last week');
  assert.equal(bucketMetaFor(7 * DAY).label, 'Last week');
});

test('bucketMetaFor buckets per whole week beyond a week, en-dash labelled', () => {
  assert.equal(bucketMetaFor(8 * DAY).label, '1–2 weeks ago');
  assert.equal(bucketMetaFor(13 * DAY).label, '1–2 weeks ago');
  assert.equal(bucketMetaFor(15 * DAY).label, '2–3 weeks ago');
  assert.equal(bucketMetaFor(30 * DAY).label, '4–5 weeks ago');
  assert.equal(bucketMetaFor(44 * DAY).label, '6–7 weeks ago');
});

test('bucketMetaFor sorts recent buckets before weekly ones, weeks newest-first', () => {
  const order = [1 * HOUR, DAY, 30 * HOUR, 5 * DAY, 8 * DAY, 15 * DAY].map((e) => bucketMetaFor(e).sort);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a negative elapsed (clock skew) lands in the newest bucket, not a phantom one', () => {
  assert.equal(bucketMetaFor(-5000).label, 'Last 4 hours');
});

test('buildBrowseBuckets orders buckets newest-first and omits empties', () => {
  const buckets = buildBrowseBuckets(
    [group('a', 1 * HOUR), group('b', 5 * HOUR), group('c', 5 * DAY), group('d', 30 * DAY)],
    [],
    NOW
  );
  assert.deepEqual(buckets.map((b) => b.label), ['Last 4 hours', 'Last day', 'Last week', '4–5 weeks ago']);
  assert.deepEqual(buckets.map((b) => b.rows.length), [1, 1, 1, 1]);
});

test('buildBrowseBuckets sorts rows within a bucket newest-first', () => {
  const [b] = buildBrowseBuckets([group('older', 3 * HOUR), group('newer', 1 * HOUR)], [], NOW);
  assert.deepEqual(b.rows.map((r) => r.group.sessionId), ['newer', 'older']);
});

test('archived tasks merge into buckets by their own archivedAt, interleaved by time', () => {
  const buckets = buildBrowseBuckets(
    [group('s1', 1 * HOUR), group('s2', 3 * HOUR)],
    [task('t1', 'Old feature', 2 * HOUR), task('t2', 'Ancient', 30 * DAY)],
    NOW
  );
  assert.deepEqual(buckets.map((b) => b.label), ['Last 4 hours', '4–5 weeks ago']);
  assert.deepEqual(
    buckets[0].rows.map((r) => (r.kind === 'task' ? r.task.id : r.group.sessionId)),
    ['s1', 't1', 's2']
  );
  assert.deepEqual(buckets[1].rows.map((r) => r.kind), ['task']);
});

test('a row with no timestamp sinks to an oldest weekly bucket instead of vanishing', () => {
  const buckets = buildBrowseBuckets([{ sessionId: 'bare', cwd: '/x' }], [], NOW);
  assert.equal(buckets.length, 1);
  assert.match(buckets[0].label, /weeks ago$/);
  assert.equal(buckets[0].rows[0].group.sessionId, 'bare');
});

test('buildBrowseBuckets tolerates null inputs', () => {
  assert.deepEqual(buildBrowseBuckets(null, null, NOW), []);
});

test('filterTasksByName: empty query returns all; matches by name case-insensitively; AND across tokens', () => {
  const tasks = [{ id: 't1', name: 'Add search' }, { id: 't2', name: 'Theme rework' }];
  assert.deepEqual(filterTasksByName(tasks, '').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(filterTasksByName(tasks, '   ').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(filterTasksByName(tasks, 'THEME').map((t) => t.id), ['t2']);
  assert.deepEqual(filterTasksByName(tasks, 'add search').map((t) => t.id), ['t1']);
  assert.deepEqual(filterTasksByName(tasks, 'add nomatch').map((t) => t.id), []);
});

test('filterTasksByName: a null/missing name does not throw', () => {
  assert.deepEqual(filterTasksByName([{ id: 't1' }], 'x'), []);
  assert.deepEqual(filterTasksByName([{ id: 't1' }], ''), [{ id: 't1' }]);
});

test('rowTitle falls through boardLabel → title → cwd basename → id prefix', () => {
  assert.equal(rowTitle({ boardLabel: 'My card', title: 't', cwd: '/a/b', sessionId: 'abcdef123456' }), 'My card');
  assert.equal(rowTitle({ title: 'Transcript title', cwd: '/a/b', sessionId: 'abcdef123456' }), 'Transcript title');
  assert.equal(rowTitle({ cwd: '/a/repo/', sessionId: 'abcdef123456' }), 'repo');
  assert.equal(rowTitle({ sessionId: 'abcdef123456' }), 'abcdef12');
});
