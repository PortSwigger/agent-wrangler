import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nestTargetsFor, childDropAction, mergeSessionOrder, gridSlotAt } from './session-drag.js';

const taskOf = (map) => (sid) => map[sid] ?? null;
const canNestOnto = (sid, target, sessions, tasks) => nestTargetsFor(sid, sessions, tasks).has(target);

test('nestTargetsFor: a same-task top-level session is a target', () => {
  const sessions = [{ sessionId: 'a', label: 'A' }, { sessionId: 'b', label: 'B' }];
  assert.equal(canNestOnto('a', 'b', sessions, taskOf({ a: 'T', b: 'T' })), true);
});

test('nestTargetsFor: refuses itself, another task, a nested target, and the current parent', () => {
  const sessions = [
    { sessionId: 'a', label: 'A', parentSession: 'p' },
    { sessionId: 'p', label: 'P' },
    { sessionId: 'c', label: 'C', parentSession: 'p' },
    { sessionId: 'x', label: 'X' },
  ];
  const tasks = taskOf({ a: 'T', p: 'T', c: 'T', x: 'U' });
  assert.equal(canNestOnto('a', 'a', sessions, tasks), false);
  assert.equal(canNestOnto('a', 'x', sessions, tasks), false);
  assert.equal(canNestOnto('a', 'c', sessions, tasks), false);
  assert.equal(canNestOnto('a', 'p', sessions, tasks), false);
  assert.equal(canNestOnto('a', null, sessions, tasks), false);
});

test('nestTargetsFor: a session with its own children cannot nest (one level deep)', () => {
  const sessions = [{ sessionId: 'p', label: 'P' }, { sessionId: 'c', label: 'C', parentSession: 'p' }, { sessionId: 'q', label: 'Q' }];
  assert.equal(canNestOnto('p', 'q', sessions, taskOf({ p: 'T', c: 'T', q: 'T' })), false);
});

test('mergeSessionOrder: shown order wins, unshown ids keep their earlier relative order after it', () => {
  assert.deepEqual(mergeSessionOrder(['b', 'a'], ['a', 'w1', 'b', 'w2']), ['b', 'a', 'w1', 'w2']);
});

test('mergeSessionOrder: dedupes and tolerates a missing previous order', () => {
  assert.deepEqual(mergeSessionOrder(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(mergeSessionOrder(['a', null, 'b'], [undefined, 'c']), ['a', 'b', 'c']);
});

test('childDropAction: a child dropped in its own spine is a plain reorder', () => {
  assert.equal(childDropAction({ spineParent: 'p', currentParent: 'p', drawnAsChild: true }), null);
});

test('childDropAction: dropped in another parent\'s spine, it moves to that parent', () => {
  assert.equal(childDropAction({ spineParent: 'q', currentParent: 'p', drawnAsChild: true }), 'attach');
});

test('childDropAction: a child dropped among the top-level cards is promoted', () => {
  assert.equal(childDropAction({ spineParent: null, currentParent: 'p', drawnAsChild: true }), 'promote');
});

test('childDropAction: a top-level card reordered among top-level cards keeps its parent link', () => {
  assert.equal(childDropAction({ spineParent: null, currentParent: null, drawnAsChild: false }), null);
  // An orphan (parent on another task) draws top-level; a reorder doesn't touch its link.
  assert.equal(childDropAction({ spineParent: null, currentParent: 'p', drawnAsChild: false }), null);
});

// Two columns, two rows: A B / C (C is shorter than its row).
const r = (left, top, w = 100, h = 80) => ({ left, right: left + w, top, bottom: top + h });
const grid = [r(0, 0), r(112, 0), r(0, 92, 100, 40)];

test('gridSlotAt: over a unit, its left half is before it and its right half after it', () => {
  assert.deepEqual(gridSlotAt(grid, 20, 40), { index: 0, after: false });
  assert.deepEqual(gridSlotAt(grid, 80, 40), { index: 0, after: true });
  assert.deepEqual(gridSlotAt(grid, 130, 40), { index: 1, after: false });
  assert.deepEqual(gridSlotAt(grid, 200, 40), { index: 1, after: true });
});

test('gridSlotAt: in a column gap, the nearest unit in that row decides', () => {
  assert.deepEqual(gridSlotAt(grid, 104, 40), { index: 0, after: true });
  assert.deepEqual(gridSlotAt(grid, 110, 40), { index: 1, after: false });
  // Beside the short C, in the empty second column of its row.
  assert.deepEqual(gridSlotAt(grid, 180, 100), { index: 2, after: true });
});

test('gridSlotAt: between or below rows, it goes after the last unit above the cursor', () => {
  assert.deepEqual(gridSlotAt(grid, 50, 86), { index: 1, after: true });
  assert.deepEqual(gridSlotAt(grid, 50, 300), { index: 2, after: true });
  assert.deepEqual(gridSlotAt(grid, 50, -10), { index: 0, after: false });
  assert.equal(gridSlotAt([], 0, 0), null);
});

test('nestTargetsFor: an empty set without a session id', () => {
  assert.equal(nestTargetsFor(null, [{ sessionId: 'a' }], () => null).size, 0);
});
