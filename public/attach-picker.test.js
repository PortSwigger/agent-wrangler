import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachCandidates, nestingDepth, orderAttachCandidates } from './attach-picker.js';

const taskOf = (taskById) => (sessionId) => taskById[sessionId] ?? null;

test('attachCandidates: only same-task sessions, alphabetical, excluding self', () => {
  const sessions = [
    { sessionId: 'S1', label: 'B' },
    { sessionId: 'S2', label: 'A' },
    { sessionId: 'S3', label: 'Other task' },
  ];
  const of = taskOf({ S1: 'T1', S2: 'T1', S3: 'T2' });
  const cands = attachCandidates('S1', sessions, of);
  assert.deepEqual(cands.map((c) => c.sessionId), ['S2']);
});

test('attachCandidates: two Ad-hoc (no-task, both null) sessions count as the same bucket', () => {
  const sessions = [{ sessionId: 'S1', label: 'A' }, { sessionId: 'S2', label: 'B' }];
  const cands = attachCandidates('S1', sessions, taskOf({}));
  assert.deepEqual(cands.map((c) => c.sessionId), ['S2']);
});

test('attachCandidates: excludes the session\'s own descendants at any depth (would make a cycle)', () => {
  const sessions = [
    { sessionId: 'A', label: 'A' },
    { sessionId: 'B', label: 'B', parentSession: 'A' },
    { sessionId: 'C', label: 'C', parentSession: 'B' },
    { sessionId: 'D', label: 'D' },
  ];
  const cands = attachCandidates('A', sessions, taskOf({}));
  assert.deepEqual(cands.map((c) => c.sessionId), ['D']);
});

test('attachCandidates: excludes the session\'s own current parent (re-attaching to it is a no-op)', () => {
  const sessions = [
    { sessionId: 'S', label: 'S', parentSession: 'P' },
    { sessionId: 'P', label: 'P' },
    { sessionId: 'Q', label: 'Q' },
  ];
  const cands = attachCandidates('S', sessions, taskOf({}));
  assert.deepEqual(cands.map((c) => c.sessionId), ['Q']);
});

test('attachCandidates: [] when the current parent is the only other session on the task', () => {
  const sessions = [
    { sessionId: 'S', label: 'S', parentSession: 'P' },
    { sessionId: 'P', label: 'P' },
  ];
  const cands = attachCandidates('S', sessions, taskOf({}));
  assert.deepEqual(cands, []);
});

test('attachCandidates: a target that is itself already nested is a valid candidate (no depth limit)', () => {
  const sessions = [
    { sessionId: 'A', label: 'A' },
    { sessionId: 'B', label: 'B', parentSession: 'A' },
    { sessionId: 'S', label: 'S' },
  ];
  const cands = attachCandidates('S', sessions, taskOf({}));
  assert.deepEqual(cands.map((c) => c.sessionId), ['A', 'B']);
});

test('attachCandidates: a session with children of its own can still move — they go with it', () => {
  const sessions = [
    { sessionId: 'S', label: 'S' },
    { sessionId: 'Child', label: 'Child', parentSession: 'S' },
    { sessionId: 'P', label: 'P' },
  ];
  const cands = attachCandidates('S', sessions, taskOf({}));
  assert.deepEqual(cands.map((c) => c.sessionId), ['P']);
});

test('attachCandidates: a child on a DIFFERENT task does not block attaching its parent elsewhere', () => {
  const sessions = [
    { sessionId: 'S', label: 'S' },
    { sessionId: 'Child', label: 'Child', parentSession: 'S' },
    { sessionId: 'P', label: 'P' },
  ];
  const of = taskOf({ S: 'T1', Child: 'T2', P: 'T1' });
  const cands = attachCandidates('S', sessions, of);
  assert.deepEqual(cands.map((c) => c.sessionId), ['P']);
});

test('nestingDepth: 0 for a root, increases one per parentSession hop', () => {
  const sessions = [
    { sessionId: 'A' },
    { sessionId: 'B', parentSession: 'A' },
    { sessionId: 'C', parentSession: 'B' },
  ];
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  assert.equal(nestingDepth(byId.get('A'), byId), 0);
  assert.equal(nestingDepth(byId.get('B'), byId), 1);
  assert.equal(nestingDepth(byId.get('C'), byId), 2);
});

test('nestingDepth: cycle-safe — never hangs, returns a finite number', () => {
  const sessions = [
    { sessionId: 'A', parentSession: 'B' },
    { sessionId: 'B', parentSession: 'A' },
  ];
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  assert.equal(typeof nestingDepth(byId.get('A'), byId), 'number');
});

test('nestingDepth: 0 when the parent is absent from byId (orphan)', () => {
  const byId = new Map([['A', { sessionId: 'A', parentSession: 'gone' }]]);
  assert.equal(nestingDepth(byId.get('A'), byId), 0);
});

test('orderAttachCandidates: puts the recorded spawner first when present', () => {
  const cands = [{ sessionId: 'A' }, { sessionId: 'B' }, { sessionId: 'C' }];
  assert.deepEqual(orderAttachCandidates(cands, 'C').map((c) => c.sessionId), ['C', 'A', 'B']);
});

test('orderAttachCandidates: unchanged when spawnedBy is absent or not a candidate', () => {
  const cands = [{ sessionId: 'A' }, { sessionId: 'B' }];
  assert.deepEqual(orderAttachCandidates(cands, null), cands);
  assert.deepEqual(orderAttachCandidates(cands, 'not-here'), cands);
});

test('orderAttachCandidates: no-op when the spawner is already first', () => {
  const cands = [{ sessionId: 'A' }, { sessionId: 'B' }];
  assert.deepEqual(orderAttachCandidates(cands, 'A'), cands);
});
