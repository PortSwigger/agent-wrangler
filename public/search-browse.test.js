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

test('buildBrowseBuckets sorts rows within a bucket newest-first (within the Unassigned cluster they fall into)', () => {
  const [b] = buildBrowseBuckets([group('older', 3 * HOUR), group('newer', 1 * HOUR)], [], NOW);
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].unassigned, true);
  assert.deepEqual(b.rows[0].entries.map((e) => e.group.sessionId), ['newer', 'older']);
});

test('archived tasks merge into buckets by their own archivedAt, interleaved by time', () => {
  const buckets = buildBrowseBuckets(
    [group('s1', 1 * HOUR), group('s2', 3 * HOUR)],
    [task('t1', 'Old feature', 2 * HOUR), task('t2', 'Ancient', 30 * DAY)],
    NOW
  );
  assert.deepEqual(buckets.map((b) => b.label), ['Last 4 hours', '4–5 weeks ago']);
  // s1/s2 (no task) fold into one Unassigned cluster (ts = s1's, the newer of
  // the two); the task-archive marker t1 stays its own row — newer than the
  // cluster? no: t1 is 2h ago vs the cluster's 1h, so the cluster sorts first.
  assert.equal(buckets[0].rows.length, 2);
  assert.equal(buckets[0].rows[0].unassigned, true);
  assert.deepEqual(buckets[0].rows[0].entries.map((e) => e.group.sessionId), ['s1', 's2']);
  assert.equal(buckets[0].rows[1].kind, 'task');
  assert.equal(buckets[0].rows[1].task.id, 't1');
  assert.deepEqual(buckets[1].rows.map((r) => r.kind), ['task']);
});

test('a row with no timestamp sinks to an oldest weekly bucket instead of vanishing', () => {
  const buckets = buildBrowseBuckets([{ sessionId: 'bare', cwd: '/x' }], [], NOW);
  assert.equal(buckets.length, 1);
  assert.match(buckets[0].label, /weeks ago$/);
  assert.equal(buckets[0].rows[0].kind, 'task-group'); // Unassigned, even alone
  assert.equal(buckets[0].rows[0].entries[0].group.sessionId, 'bare');
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

// ── task grouping ────────────────────────────────────────────────────────────

test('two same-task rows in one bucket cluster under a task-group heading', () => {
  const [b] = buildBrowseBuckets(
    [group('s1', 1 * HOUR, { taskId: 't1', task: 'Auth work' }), group('s2', 2 * HOUR, { taskId: 't1', task: 'Auth work' })],
    [], NOW
  );
  assert.deepEqual(b.rows.map((r) => r.kind), ['task-group']);
  assert.equal(b.rows[0].taskId, 't1');
  assert.equal(b.rows[0].taskName, 'Auth work');
  assert.deepEqual(b.rows[0].entries.map((e) => e.group.sessionId), ['s1', 's2']); // newest first
});

test('a lone session for a task stays a plain row — no heading for a singleton', () => {
  const [b] = buildBrowseBuckets([group('s1', 1 * HOUR, { taskId: 't1', task: 'Auth work' })], [], NOW);
  assert.deepEqual(b.rows.map((r) => r.kind), ['session']);
});

test('a task-group heading uses the newest snapshot name, even if an older one drifted', () => {
  const [b] = buildBrowseBuckets(
    [group('s1', 1 * HOUR, { taskId: 't1', task: 'Renamed task' }), group('s2', 2 * HOUR, { taskId: 't1', task: 'Old name' })],
    [], NOW
  );
  assert.equal(b.rows[0].taskName, 'Renamed task');
});

test('same-task rows split across buckets do not cluster — grouping is per-bucket', () => {
  const buckets = buildBrowseBuckets(
    [group('s1', 1 * HOUR, { taskId: 't1', task: 'Auth work' }), group('s2', 2 * DAY, { taskId: 't1', task: 'Auth work' })],
    [], NOW
  );
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].rows[0].kind, 'session');
  assert.equal(buckets[1].rows[0].kind, 'session');
});

// ── parent/child hierarchy ───────────────────────────────────────────────────

// Each top-level identity below carries its own distinct taskId — a plain,
// unrelated way to keep it OUT of the (always-on, unthrottled) Unassigned
// cluster, so these assertions can inspect a folded row directly instead of
// reaching into an Unassigned entries array for a concern these tests aren't
// about. A singleton real task stays a plain 'session' row (see foldTaskGroups),
// same shape these tests already expect.

test('a child in the same bucket as its parent nests under it, not as its own row', () => {
  const [b] = buildBrowseBuckets(
    [
      group('p', 2 * HOUR, { cardId: 'card-p', taskId: 't-p', task: 'P task' }),
      group('c', 1 * HOUR, { cardId: 'card-c', parentSession: 'card-p' }),
    ],
    [], NOW
  );
  const p = b.rows.find((r) => r.kind === 'session' && r.group.sessionId === 'p');
  assert.equal(p.group.sessionId, 'p');
  assert.deepEqual(p.children.map((c) => c.sessionId), ['c']);
});

test('a grandchild promotes to top-level instead of nesting two deep', () => {
  const [b] = buildBrowseBuckets(
    [
      group('p', 3 * HOUR, { cardId: 'card-p', taskId: 't-p', task: 'P task' }),
      group('c', 2 * HOUR, { cardId: 'card-c', parentSession: 'card-p' }),
      group('gc', 1 * HOUR, { cardId: 'card-gc', parentSession: 'card-c', taskId: 't-gc', task: 'GC task' }),
    ],
    [], NOW
  );
  // p absorbs c; c is itself absorbed, so gc (parented on c) promotes to top-level.
  const sessions = b.rows.filter((r) => r.kind === 'session');
  assert.equal(sessions.length, 2);
  const p = sessions.find((r) => r.group.sessionId === 'p');
  const gc = sessions.find((r) => r.group.sessionId === 'gc');
  assert.deepEqual(p.children.map((c) => c.sessionId), ['c']);
  assert.equal(gc.children, undefined);
});

test('a parent in a different bucket does not nest across the boundary — the child gets a breadcrumb instead', () => {
  const buckets = buildBrowseBuckets(
    [
      group('p', 2 * DAY, { cardId: 'card-p', boardLabel: 'Parent run', taskId: 't-p', task: 'P task' }),
      group('c', 1 * HOUR, { cardId: 'card-c', parentSession: 'card-p', taskId: 't-c', task: 'C task' }),
    ],
    [], NOW
  );
  const childBucket = buckets.find((bk) => bk.rows.some((r) => r.kind === 'session' && r.group.sessionId === 'c'));
  const row = childBucket.rows.find((r) => r.kind === 'session' && r.group.sessionId === 'c');
  assert.equal(row.children, undefined);
  assert.equal(row.parentTitle, 'Parent run');
  const parentBucket = buckets.find((bk) => bk.rows.some((r) => r.kind === 'session' && r.group.sessionId === 'p'));
  const parentRow = parentBucket.rows.find((r) => r.kind === 'session' && r.group.sessionId === 'p');
  assert.equal(parentRow.children, undefined); // the child isn't hoisted up to it either
});

test('an orphan child (parent not present at all) stays a loose row with no breadcrumb', () => {
  const [b] = buildBrowseBuckets(
    [group('c', 1 * HOUR, { cardId: 'card-c', parentSession: 'card-ghost', taskId: 't-c', task: 'C task' })],
    [], NOW
  );
  assert.equal(b.rows[0].kind, 'session');
  assert.equal(b.rows[0].parentTitle, undefined);
});

// ── task-archive nesting ─────────────────────────────────────────────────────

test('sessions cascade-archived alongside an archived task nest under its marker, not as loose rows', () => {
  const [b] = buildBrowseBuckets(
    [group('s1', 1 * HOUR, { viaTaskArchive: 't1' }), group('s2', 2 * HOUR, { viaTaskArchive: 't1' })],
    [task('t1', 'Retired feature', 30 * 60e3)],
    NOW
  );
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].kind, 'task');
  assert.deepEqual(b.rows[0].nested.map((s) => s.sessionId), ['s1', 's2']); // newest first
});

test('a viaTaskArchive session whose task is not in the archived-tasks list falls through as a loose row', () => {
  const [b] = buildBrowseBuckets(
    [group('s1', 1 * HOUR, { viaTaskArchive: 't1', taskId: 't1', task: 'Some task' })],
    [], NOW
  );
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].kind, 'session');
});

// ── Unassigned grouping ──────────────────────────────────────────────────────

test('sessions with no task fold into one Unassigned cluster, even a single one', () => {
  const [b] = buildBrowseBuckets([group('s1', 1 * HOUR)], [], NOW);
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].kind, 'task-group');
  assert.equal(b.rows[0].unassigned, true);
  assert.equal(b.rows[0].taskName, 'Unassigned');
  assert.equal(b.rows[0].taskId, null);
  assert.deepEqual(b.rows[0].entries.map((e) => e.group.sessionId), ['s1']);
});

test('Unassigned and a real task-group coexist as separate clusters in one bucket', () => {
  const [b] = buildBrowseBuckets(
    [
      group('s1', 1 * HOUR),
      group('s2', 2 * HOUR, { taskId: 't1', task: 'Auth work' }),
      group('s3', 3 * HOUR, { taskId: 't1', task: 'Auth work' }),
    ],
    [], NOW
  );
  assert.equal(b.rows.length, 2);
  assert.deepEqual(b.rows.map((r) => r.unassigned || false), [true, false]);
  assert.deepEqual(b.rows[1].entries.map((e) => e.group.sessionId), ['s2', 's3']);
});
