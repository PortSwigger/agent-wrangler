import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nestTargetsFor, childDropAction, mergeSessionOrder, gridSlotAt, subtreeEnd, childSlotAt } from './session-drag.js';

const taskOf = (map) => (sid) => map[sid] ?? null;
const canNestOnto = (sid, target, sessions, tasks) => nestTargetsFor(sid, sessions, tasks).has(target);

test('nestTargetsFor: a same-task top-level session is a target', () => {
  const sessions = [{ sessionId: 'a', label: 'A' }, { sessionId: 'b', label: 'B' }];
  assert.equal(canNestOnto('a', 'b', sessions, taskOf({ a: 'T', b: 'T' })), true);
});

test('nestTargetsFor: refuses itself, another task, and the current parent, but allows a nested target', () => {
  const sessions = [
    { sessionId: 'a', label: 'A', parentSession: 'p' },
    { sessionId: 'p', label: 'P' },
    { sessionId: 'c', label: 'C', parentSession: 'p' },
    { sessionId: 'x', label: 'X' },
  ];
  const tasks = taskOf({ a: 'T', p: 'T', c: 'T', x: 'U' });
  assert.equal(canNestOnto('a', 'a', sessions, tasks), false);
  assert.equal(canNestOnto('a', 'x', sessions, tasks), false);
  assert.equal(canNestOnto('a', 'p', sessions, tasks), false);
  assert.equal(canNestOnto('a', null, sessions, tasks), false);
  // Nesting has no depth limit: a sibling that is itself nested is a target.
  assert.equal(canNestOnto('a', 'c', sessions, tasks), true);
});

test('nestTargetsFor: a session with children can move, but never under its own descendants', () => {
  const sessions = [
    { sessionId: 'p', label: 'P' },
    { sessionId: 'c', label: 'C', parentSession: 'p' },
    { sessionId: 'g', label: 'G', parentSession: 'c' },
    { sessionId: 'q', label: 'Q' },
  ];
  const tasks = taskOf({ p: 'T', c: 'T', g: 'T', q: 'T' });
  assert.equal(canNestOnto('p', 'q', sessions, tasks), true);
  assert.equal(canNestOnto('p', 'c', sessions, tasks), false);
  assert.equal(canNestOnto('p', 'g', sessions, tasks), false);
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

// A root's spine: a (with child a1, grandchild a1x), then b. 30px rows, 6px gaps.
const row = (parent, depth, i) => ({ parent, depth, top: i * 36, bottom: i * 36 + 30 });
const spine = [row('root', 0, 0), row('a', 1, 1), row('a1', 2, 2), row('root', 0, 3)];

test('subtreeEnd: a row\'s subtree runs until the next row no deeper than it', () => {
  assert.equal(subtreeEnd(spine, 0), 3);
  assert.equal(subtreeEnd(spine, 1), 3);
  assert.equal(subtreeEnd(spine, 3), 4);
});

test('childSlotAt: slots sit only between siblings, never inside a sibling\'s subtree', () => {
  // Above a's midpoint: before a.
  assert.equal(childSlotAt(spine, 'root', 5), 0);
  // Over a's children, past a's midpoint but above b's: before b, after a's subtree.
  assert.equal(childSlotAt(spine, 'root', 80), 3);
  // Past b: after b (append).
  assert.equal(childSlotAt(spine, 'root', 200), 4);
});

test('childSlotAt: a deeper parent\'s children, and none when the parent has no other children', () => {
  assert.equal(childSlotAt(spine, 'a', 0), 1);
  assert.equal(childSlotAt(spine, 'a', 200), 3);
  assert.equal(childSlotAt(spine, 'nobody', 0), null);
});
