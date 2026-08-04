import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupHistory, fmtDuration, filterHistory, filterArchivedTasks } from './history-group.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// A fixed "now" so elapsed-time buckets are deterministic.
const NOW = 1_000 * DAY;

function item(id, agoMs, extra = {}) {
  return { sessionId: id, name: id, cwd: '/x', archivedAt: NOW - agoMs, ...extra };
}

test('fmtDuration formats compactly and degrades gracefully', () => {
  assert.equal(fmtDuration(null), null);
  assert.equal(fmtDuration(0), null);
  assert.equal(fmtDuration(-5), null);
  assert.equal(fmtDuration(30e3), '<1m');
  assert.equal(fmtDuration(22 * 60e3), '22m');
  assert.equal(fmtDuration(HOUR + 47 * 60e3), '1h 47m');
  assert.equal(fmtDuration(3 * HOUR), '3h');
  assert.equal(fmtDuration(3 * DAY + 2 * HOUR), '3d 2h');
  assert.equal(fmtDuration(2 * DAY), '2d');
});

test('buckets sort across the boundaries, newest bucket first, empties omitted', () => {
  const history = [
    item('a', 1 * HOUR),     // Last 4 hours
    item('b', 5 * HOUR),     // Last day
    item('c', 30 * HOUR),    // Last 2 days
    item('d', 5 * DAY),      // Last week
    item('e', 30 * DAY),     // 4–5 weeks ago (floor(30/7) = 4)
  ];
  const groups = groupHistory(history, { tasks: [], order: ['adhoc'], assignments: {} }, NOW);
  assert.deepEqual(
    groups.map((g) => g.label),
    ['Last 4 hours', 'Last day', 'Last 2 days', 'Last week', '4–5 weeks ago']
  );
  assert.deepEqual(groups.map((g) => g.count), [1, 1, 1, 1, 1]);
  assert.deepEqual(groups.map((g) => g.older), [false, false, false, false, true]);
});

test('beyond a week, sessions bucket per whole week elapsed, newest week first', () => {
  const history = [
    item('w1', 8 * DAY),     // 1–2 weeks ago
    item('w1b', 13 * DAY),   // 1–2 weeks ago (same bucket)
    item('w2', 15 * DAY),    // 2–3 weeks ago
    item('w6', 44 * DAY),    // 6–7 weeks ago (floor(44/7) = 6)
  ];
  const groups = groupHistory(history, { tasks: [], order: ['adhoc'], assignments: {} }, NOW);
  assert.deepEqual(groups.map((g) => g.label), ['1–2 weeks ago', '2–3 weeks ago', '6–7 weeks ago']);
  assert.deepEqual(groups.map((g) => g.count), [2, 1, 1]);
  assert.ok(groups.every((g) => g.older), 'every beyond-a-week bucket is flagged older');
});

test('boundaries are inclusive at exactly 4h / 1d / 2d / 1w', () => {
  const history = [
    item('h4', 4 * HOUR),
    item('d1', DAY),
    item('d2', 2 * DAY),
    item('w1', 7 * DAY),
  ];
  const groups = groupHistory(history, { tasks: [], order: ['adhoc'], assignments: {} }, NOW);
  assert.deepEqual(groups.map((g) => g.label), ['Last 4 hours', 'Last day', 'Last 2 days', 'Last week']);
});

test('within a bucket, tasks follow board order and Unassigned is always last', () => {
  const tasks = {
    tasks: [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Beta' }],
    order: ['t2', 'adhoc', 't1'],
    assignments: { a: 't1', b: 't2' },
  };
  const history = [item('a', 1 * HOUR), item('b', 2 * HOUR), item('u', 3 * HOUR)];
  const [g] = groupHistory(history, tasks, NOW);
  assert.equal(g.label, 'Last 4 hours');
  assert.deepEqual(
    g.tiles.map((t) => t.taskName),
    ['Beta', 'Alpha', 'Unassigned']
  );
  assert.equal(g.tiles.at(-1).unassigned, true);
});

test('sessions within a tile are newest-first', () => {
  const tasks = { tasks: [{ id: 't1', name: 'Alpha' }], order: ['t1', 'adhoc'], assignments: { a: 't1', b: 't1' } };
  const history = [item('a', 3 * HOUR), item('b', 1 * HOUR)];
  const [g] = groupHistory(history, tasks, NOW);
  assert.deepEqual(g.tiles[0].units.map((u) => u.session.sessionId), ['b', 'a']);
});

test('a deleted task lands in Unassigned with wasName from the snapshot', () => {
  const tasks = { tasks: [], order: ['adhoc'], assignments: {} };
  const history = [item('a', 1 * HOUR, { task: { id: 'gone', name: 'Test stabilisation' } })];
  const [g] = groupHistory(history, tasks, NOW);
  assert.equal(g.tiles.length, 1);
  const tile = g.tiles[0];
  assert.equal(tile.unassigned, true);
  assert.equal(tile.units[0].session.wasName, 'Test stabilisation');
});

test('a still-assigned session groups under its live task name, not the snapshot', () => {
  const tasks = { tasks: [{ id: 't1', name: 'Renamed Alpha' }], order: ['t1', 'adhoc'], assignments: { a: 't1' } };
  const history = [item('a', 1 * HOUR, { task: { id: 't1', name: 'Old Alpha' } })];
  const [g] = groupHistory(history, tasks, NOW);
  assert.equal(g.tiles[0].taskName, 'Renamed Alpha');
  assert.equal(g.tiles[0].units[0].session.wasName, null);
});

test('never-assigned session goes to Unassigned with no wasName', () => {
  const tasks = { tasks: [], order: ['adhoc'], assignments: {} };
  const history = [item('a', 1 * HOUR)];
  const [g] = groupHistory(history, tasks, NOW);
  assert.equal(g.tiles[0].unassigned, true);
  assert.equal(g.tiles[0].units[0].session.wasName, null);
});

test('filterHistory: empty query returns all', () => {
  const h = [{ sessionId: 'a', label: 'foo' }, { sessionId: 'b', label: 'bar' }];
  assert.equal(filterHistory(h, '').length, 2);
  assert.equal(filterHistory(h, '   ').length, 2);
});

test('filterHistory: matches across fields, case-insensitive', () => {
  const h = [
    { sessionId: 'a', label: 'Add search', cwd: '/vcs/aw', model: 'claude-sonnet-4-6', agent: 'claude' },
    { sessionId: 'b', label: 'Theme', cwd: '/vcs/other', model: 'gpt-5.5', agent: 'codex', task: { name: 'Theming' } },
    { sessionId: 'c', label: 'WT', worktree: { branch: 'add-history-search', path: '/vcs/aw-wt' } },
  ];
  assert.deepEqual(filterHistory(h, 'sonnet').map((x) => x.sessionId), ['a']);
  assert.deepEqual(filterHistory(h, 'CODEX').map((x) => x.sessionId), ['b']);
  assert.deepEqual(filterHistory(h, 'theming').map((x) => x.sessionId), ['b']);
  assert.deepEqual(filterHistory(h, 'add-history').map((x) => x.sessionId), ['c']);
});

test('filterHistory: multi-token requires all tokens (AND)', () => {
  const h = [
    { sessionId: 'a', label: 'Add search', cwd: '/vcs/wrangler', model: 'claude-sonnet-4-6' },
    { sessionId: 'b', label: 'Add search', cwd: '/vcs/other', model: 'gpt-5.5' },
  ];
  assert.deepEqual(filterHistory(h, 'wrangler sonnet').map((x) => x.sessionId), ['a']);
  assert.equal(filterHistory(h, 'wrangler nomatch').length, 0);
});

test('filterHistory: null/absent fields do not throw', () => {
  const h = [{ sessionId: 'a' }];
  assert.equal(filterHistory(h, 'x').length, 0);
  assert.equal(filterHistory(h, '').length, 1);
});

const ADHOC = { tasks: [], order: ['adhoc'], assignments: {} };

test('a run folds its present workers into one workflow unit (workers omitted as loose cards)', () => {
  const history = [
    item('orch', 1 * HOUR, { workflow: { issue: 'ENT-1', phase: { label: 'opened PR', kind: 'success' } } }),
    item('w1', 2 * HOUR, { parentSession: 'orch' }),
    item('w2', 3 * HOUR, { parentSession: 'orch' }),
  ];
  const [g] = groupHistory(history, ADHOC, NOW);
  const tile = g.tiles[0];
  assert.equal(tile.units.length, 1, 'one workflow unit, no loose worker cards');
  const u = tile.units[0];
  assert.equal(u.kind, 'workflow');
  assert.equal(u.orch.sessionId, 'orch');
  assert.deepEqual(u.workers.map((w) => w.sessionId), ['w1', 'w2']); // archivedAt desc
  assert.equal(u.issue, 'ENT-1');
  assert.deepEqual(u.outcome, { label: 'opened PR', kind: 'success' });
  assert.equal(tile.count, 3); // orchestrator + both workers
});

test('a run with no phase reports a null outcome but keeps its issue', () => {
  const history = [
    item('orch', 1 * HOUR, { workflow: { issue: 'ENT-2' } }),
    item('w1', 2 * HOUR, { parentSession: 'orch' }),
  ];
  const u = groupHistory(history, ADHOC, NOW)[0].tiles[0].units[0];
  assert.equal(u.kind, 'workflow');
  assert.equal(u.issue, 'ENT-2');
  assert.equal(u.outcome, null);
});

test('a solo orchestrator and an orphan worker stay loose cards', () => {
  const history = [
    item('solo', 1 * HOUR, { workflow: { issue: 'ENT-3', phase: { label: 'planning', kind: 'active' } } }),
    item('orphan', 2 * HOUR, { parentSession: 'absent-orch' }),
  ];
  const tile = groupHistory(history, ADHOC, NOW)[0].tiles[0];
  assert.deepEqual(tile.units.map((u) => u.kind), ['card', 'card']);
  assert.deepEqual(tile.units.map((u) => u.session.sessionId), ['solo', 'orphan']);
  assert.equal(tile.count, 2);
});

test('a worker in a different time-bucket than its orchestrator is an orphan card there', () => {
  const history = [
    item('orch', 1 * HOUR, { workflow: { issue: 'ENT-5', phase: { label: 'done', kind: 'success' } } }),
    item('wFar', 30 * DAY, { parentSession: 'orch' }), // Older bucket
  ];
  const groups = groupHistory(history, ADHOC, NOW);
  // The orchestrator's bucket has no present worker → it stays a loose card (no box).
  const recent = groups.find((g) => g.label === 'Last 4 hours');
  assert.equal(recent.tiles[0].units[0].kind, 'card');
  assert.equal(recent.tiles[0].units[0].session.sessionId, 'orch');
  // The worker's bucket has no orchestrator → orphan loose card.
  const older = groups.find((g) => g.label === '4–5 weeks ago');
  assert.equal(older.tiles[0].units[0].kind, 'card');
  assert.equal(older.tiles[0].units[0].session.sessionId, 'wFar');
});

test('two runs in one tile fold into two boxes', () => {
  const history = [
    item('orchA', 1 * HOUR, { workflow: { issue: 'ENT-A' } }),
    item('a1', 2 * HOUR, { parentSession: 'orchA' }),
    item('orchB', 3 * HOUR, { workflow: { issue: 'ENT-B' } }),
    item('b1', 4 * HOUR, { parentSession: 'orchB' }),
  ];
  const tile = groupHistory(history, ADHOC, NOW)[0].tiles[0];
  assert.deepEqual(tile.units.map((u) => u.kind), ['workflow', 'workflow']);
  assert.deepEqual(tile.units.map((u) => u.orch.sessionId), ['orchA', 'orchB']);
  assert.equal(tile.count, 4);
});

test('a generic (non-workflow) parent folds its present children into a children unit', () => {
  const history = [
    item('reviewed', 1 * HOUR),
    item('review', 2 * HOUR, { parentSession: 'reviewed' }),
  ];
  const tile = groupHistory(history, ADHOC, NOW)[0].tiles[0];
  assert.equal(tile.units.length, 1, 'one children unit, no loose child card');
  const u = tile.units[0];
  assert.equal(u.kind, 'children');
  assert.equal(u.session.sessionId, 'reviewed');
  assert.deepEqual(u.children.map((c) => c.sessionId), ['review']);
  assert.equal(tile.count, 2);
});

test('an orphan generic child (parent not present) stays a loose card', () => {
  const history = [item('orphan', 1 * HOUR, { parentSession: 'absent-parent' })];
  const tile = groupHistory(history, ADHOC, NOW)[0].tiles[0];
  assert.deepEqual(tile.units.map((u) => u.kind), ['card']);
  assert.equal(tile.units[0].session.sessionId, 'orphan');
});

test('a chained grandchild is promoted to its own unit when its parent is itself absorbed', () => {
  const history = [
    item('root', 1 * HOUR),
    item('mid', 2 * HOUR, { parentSession: 'root' }),
    item('leaf', 3 * HOUR, { parentSession: 'mid' }),
  ];
  const tile = groupHistory(history, ADHOC, NOW)[0].tiles[0];
  // `mid` is absorbed into `root`'s stack; `leaf`'s parent (`mid`) is itself
  // absorbed, so `leaf` is promoted to its own top-level unit instead of being
  // silently dropped.
  assert.deepEqual(tile.units.map((u) => u.kind), ['children', 'card']);
  assert.equal(tile.units[0].session.sessionId, 'root');
  assert.deepEqual(tile.units[0].children.map((c) => c.sessionId), ['mid']);
  assert.equal(tile.units[1].session.sessionId, 'leaf');
  assert.equal(tile.count, 3);
});

test('filterHistory matches a run by its workflow issue', () => {
  const h = [
    { sessionId: 'orch', label: 'autopilot', workflow: { issue: 'ENT-1234', phase: null } },
    { sessionId: 'other', label: 'unrelated' },
  ];
  assert.deepEqual(filterHistory(h, 'ent-1234').map((x) => x.sessionId), ['orch']);
});

// archivedTask mirrors item()'s shape but for the 4th groupHistory argument —
// {id, name, archivedAt} straight off a TaskStore snapshot's tasks array.
function archivedTask(id, name, agoMs) {
  return { id, name, archivedAt: NOW - agoMs };
}

test('groupHistory with no 4th argument behaves exactly as before (archived tasks are opt-in)', () => {
  const history = [item('a', 1 * HOUR)];
  const groups = groupHistory(history, ADHOC, NOW);
  assert.equal(groups[0].tiles[0].units.length, 1);
  assert.equal(groups[0].tiles[0].units[0].kind, 'card');
});

test('an archived task with no sessions gets its own tile with just the marker unit', () => {
  const tasks = { tasks: [{ id: 't1', name: 'Old feature', archivedAt: NOW - 1 * HOUR }], order: ['t1', 'adhoc'], assignments: {} };
  const groups = groupHistory([], tasks, NOW, [archivedTask('t1', 'Old feature', 1 * HOUR)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Last 4 hours');
  const tile = groups[0].tiles[0];
  assert.equal(tile.taskName, 'Old feature');
  assert.equal(tile.unassigned, false);
  assert.equal(tile.count, 1);
  assert.deepEqual(tile.units.map((u) => u.kind), ['task-archive']);
  assert.equal(tile.units[0].task.id, 't1');
});

test('a task archived alongside its cascade-archived sessions lands in the same tile, marker leading', () => {
  const tasks = {
    tasks: [{ id: 't1', name: 'Cascaded', archivedAt: NOW - 1 * HOUR }],
    order: ['t1', 'adhoc'],
    assignments: { s1: 't1', s2: 't1' },
  };
  const history = [item('s1', 1 * HOUR), item('s2', 1 * HOUR)];
  const groups = groupHistory(history, tasks, NOW, [archivedTask('t1', 'Cascaded', 1 * HOUR)]);
  assert.equal(groups.length, 1);
  const tile = groups[0].tiles[0];
  assert.equal(tile.count, 3); // marker + 2 sessions
  assert.deepEqual(tile.units.map((u) => u.kind), ['task-archive', 'card', 'card']);
  assert.equal(tile.units[0].task.id, 't1');
});

test('an archived task in a different time-bucket than its (earlier-archived) sessions gets its own bucket instance', () => {
  const tasks = {
    tasks: [{ id: 't1', name: 'Long-lived', archivedAt: NOW - 1 * HOUR }],
    order: ['t1', 'adhoc'],
    assignments: {},
  };
  // The session was archived weeks before the task itself was archived (e.g. a
  // manually-archived session, unrelated to this task-archive event).
  const history = [item('old', 30 * DAY, { task: { id: 't1', name: 'Long-lived' } })];
  const groups = groupHistory(history, tasks, NOW, [archivedTask('t1', 'Long-lived', 1 * HOUR)]);
  const recent = groups.find((g) => g.label === 'Last 4 hours');
  const older = groups.find((g) => g.label === '4–5 weeks ago');
  assert.deepEqual(recent.tiles[0].units.map((u) => u.kind), ['task-archive']);
  assert.deepEqual(older.tiles[0].units.map((u) => u.kind), ['card']);
});

test('an archived task tile sorts among live task tiles by the board order, Unassigned still last', () => {
  const tasks = {
    tasks: [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Archived beta', archivedAt: NOW - 1 * HOUR }],
    order: ['t2', 'adhoc', 't1'],
    assignments: { a: 't1' },
  };
  const history = [item('a', 1 * HOUR), item('u', 1 * HOUR)];
  const [g] = groupHistory(history, tasks, NOW, [archivedTask('t2', 'Archived beta', 1 * HOUR)]);
  assert.deepEqual(g.tiles.map((t) => t.taskName), ['Archived beta', 'Alpha', 'Unassigned']);
});

test('filterArchivedTasks: empty query returns all; matches by name case-insensitively; AND across tokens', () => {
  const tasks = [{ id: 't1', name: 'Add search' }, { id: 't2', name: 'Theme rework' }];
  assert.deepEqual(filterArchivedTasks(tasks, '').map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(filterArchivedTasks(tasks, 'THEME').map((t) => t.id), ['t2']);
  assert.deepEqual(filterArchivedTasks(tasks, 'add search').map((t) => t.id), ['t1']);
  assert.deepEqual(filterArchivedTasks(tasks, 'add nomatch').map((t) => t.id), []);
});

test('filterArchivedTasks: a null/missing name does not throw', () => {
  assert.deepEqual(filterArchivedTasks([{ id: 't1' }], 'x'), []);
  assert.deepEqual(filterArchivedTasks([{ id: 't1' }], ''), [{ id: 't1' }]);
});
