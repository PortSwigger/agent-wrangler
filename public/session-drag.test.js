import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canNestOnto, childDropAction, mergeSessionOrder } from './session-drag.js';

const taskOf = (map) => (sid) => map[sid] ?? null;

test('canNestOnto: a same-task top-level session is a target', () => {
  const sessions = [{ sessionId: 'a', label: 'A' }, { sessionId: 'b', label: 'B' }];
  assert.equal(canNestOnto('a', 'b', sessions, taskOf({ a: 'T', b: 'T' })), true);
});

test('canNestOnto: refuses itself, another task, a nested target, and the current parent', () => {
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

test('canNestOnto: a session with its own children cannot nest (one level deep)', () => {
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
