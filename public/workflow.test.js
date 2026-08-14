import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowPhaseLabel, isWorkflowRun, isWorkflowWorker, computeAbsorption, sessionGroups } from './workflow.js';

test('workflowPhaseLabel: absent / phase-less workflow → null', () => {
  assert.equal(workflowPhaseLabel(null), null);
  assert.equal(workflowPhaseLabel(undefined), null);
  assert.equal(workflowPhaseLabel({}), null);
  assert.equal(workflowPhaseLabel({ phase: {} }), null); // a phase with no label is not a word
});

test('workflowPhaseLabel: returns the phase label', () => {
  assert.equal(workflowPhaseLabel({ phase: { label: 'planning', kind: 'active' } }), 'planning');
  assert.equal(workflowPhaseLabel({ phase: { label: 'implementing' } }), 'implementing');
  assert.equal(workflowPhaseLabel({ phase: { label: '  done  ' } }), 'done'); // trims
});

test('isWorkflowRun: any session carrying a workflow marker is an orchestrator run', () => {
  assert.equal(isWorkflowRun({ workflow: { issue: 'ENT-1', phase: { label: 'implementing' } } }), true);
  assert.equal(isWorkflowRun({ workflow: {} }), true); // a bare marker (e.g. just-started) still reads as a run
  assert.equal(isWorkflowRun({ parentSession: 'ORCH' }), false); // a child with no workflow of its own is not a run
  assert.equal(isWorkflowRun({}), false);
  assert.equal(isWorkflowRun(null), false);
});

test('isWorkflowWorker: a child is a worker only when its parent is itself a workflow run', () => {
  const byId = new Map([
    ['ORCH', { sessionId: 'ORCH', workflow: { issue: 'ENT-1' } }],
    ['REVIEWED', { sessionId: 'REVIEWED' }], // a plain parent — not a workflow run
  ]);
  assert.equal(isWorkflowWorker({ parentSession: 'ORCH' }, byId), true);
  assert.equal(isWorkflowWorker({ parentSession: 'REVIEWED' }, byId), false); // a review, not a worker
  assert.equal(isWorkflowWorker({ parentSession: 'ORCH' }, new Map()), false); // parent absent (orphan)
  assert.equal(isWorkflowWorker({ workflow: { issue: 'ENT-1' } }, byId), false); // orchestrator itself
  assert.equal(isWorkflowWorker({}, byId), false);
  assert.equal(isWorkflowWorker(undefined, byId), false);
});

test('computeAbsorption: a child whose parent is present folds into the spine', () => {
  const parent = { sessionId: 'p' };
  const child = { sessionId: 'c', parentSession: 'p' };
  const { absorbed, childrenByParent } = computeAbsorption([parent, child]);
  assert.equal(absorbed.has('c'), true);
  assert.equal(absorbed.has('p'), false);
  assert.deepEqual(childrenByParent.get('p'), [child]);
});

test('computeAbsorption: an orphan child (parent not in the set) is not absorbed', () => {
  const child = { sessionId: 'c', parentSession: 'missing' };
  const { absorbed, childrenByParent } = computeAbsorption([child]);
  assert.equal(absorbed.has('c'), false);
  assert.equal(childrenByParent.size, 0);
});

test('computeAbsorption: a chained grandchild promotes to top-level when its parent is itself absorbed', () => {
  const orch = { sessionId: 'orch' };
  const worker = { sessionId: 'worker', parentSession: 'orch' };
  const grandchild = { sessionId: 'grandchild', parentSession: 'worker' };
  const { absorbed, childrenByParent } = computeAbsorption([orch, worker, grandchild]);
  assert.equal(absorbed.has('worker'), true);
  assert.equal(absorbed.has('grandchild'), false); // worker is itself absorbed, so it can't absorb further
  assert.deepEqual(childrenByParent.get('orch'), [worker]);
  assert.equal(childrenByParent.has('worker'), false);
});

test('computeAbsorption: a cycle never hangs — the guard breaks it deterministically', () => {
  const a = { sessionId: 'a', parentSession: 'b' };
  const b = { sessionId: 'b', parentSession: 'a' };
  const { absorbed } = computeAbsorption([a, b]);
  // Exactly one side of the cycle ends up absorbed (the guard defaults the
  // in-progress node to "not absorbed", which the other node then reads as its
  // parent being top-level) — never both, never neither, and it terminates.
  assert.equal(absorbed.size, 1);
});

const groupIds = (sessions) =>
  sessionGroups(sessions).map(({ session, children }) => [session.sessionId, children.map((c) => c.sessionId)]);

test('sessionGroups: a child is grouped at its PARENT\'s slot, not its own place in the flat order', () => {
  // Flat order puts the child last, but it draws on the parent's spine, so the
  // drawn (and keyboard-nav) order is parent → child → the unrelated session.
  const parent = { sessionId: 'p' };
  const other = { sessionId: 'o' };
  const child = { sessionId: 'c', parentSession: 'p' };
  assert.deepEqual(groupIds([parent, other, child]), [['p', ['c']], ['o', []]]);
});

test('sessionGroups: children keep their relative order within the spine', () => {
  const parent = { sessionId: 'p' };
  const c1 = { sessionId: 'c1', parentSession: 'p' };
  const c2 = { sessionId: 'c2', parentSession: 'p' };
  assert.deepEqual(groupIds([c2, parent, c1]), [['p', ['c2', 'c1']]]);
});

test('sessionGroups: a promoted grandchild keeps its own flat slot, with its own children', () => {
  const orch = { sessionId: 'orch' };
  const worker = { sessionId: 'worker', parentSession: 'orch' };
  const grand = { sessionId: 'grand', parentSession: 'worker' };
  const great = { sessionId: 'great', parentSession: 'grand' };
  assert.deepEqual(groupIds([orch, worker, grand, great]), [['orch', ['worker']], ['grand', ['great']]]);
});

test('sessionGroups: an orphan child stays top-level in its own slot', () => {
  const orphan = { sessionId: 'c', parentSession: 'elsewhere' };
  assert.deepEqual(groupIds([{ sessionId: 'a' }, orphan]), [['a', []], ['c', []]]);
});
