import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowPhaseLabel, isWorkflowRun, isWorkflowWorker, computeAbsorption, sessionGroups, spineRows, MAX_SPINE_INDENT } from './workflow.js';

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

test('computeAbsorption: a chained grandchild is absorbed too — nesting has no depth limit', () => {
  const orch = { sessionId: 'orch' };
  const worker = { sessionId: 'worker', parentSession: 'orch' };
  const grandchild = { sessionId: 'grandchild', parentSession: 'worker' };
  const { absorbed, childrenByParent } = computeAbsorption([orch, worker, grandchild]);
  assert.deepEqual([...absorbed], ['worker', 'grandchild']);
  assert.deepEqual(childrenByParent.get('orch'), [worker]);
  assert.deepEqual(childrenByParent.get('worker'), [grandchild]);
});

test('computeAbsorption: a grandchild whose grandparent is missing still hangs off its present parent', () => {
  const mid = { sessionId: 'mid', parentSession: 'gone' };
  const leaf = { sessionId: 'leaf', parentSession: 'mid' };
  const { absorbed } = computeAbsorption([mid, leaf]);
  assert.deepEqual([...absorbed], ['leaf']);
});

test('computeAbsorption: a cycle never hangs or vanishes — its first-listed member stays top-level', () => {
  const a = { sessionId: 'a', parentSession: 'b' };
  const b = { sessionId: 'b', parentSession: 'a' };
  assert.deepEqual([...computeAbsorption([a, b]).absorbed], ['b']);
  assert.deepEqual([...computeAbsorption([b, a]).absorbed], ['a']);
});

test('computeAbsorption: a self-parented session stays top-level', () => {
  const a = { sessionId: 'a', parentSession: 'a' };
  assert.equal(computeAbsorption([a]).absorbed.size, 0);
});

test('computeAbsorption: a long chain absorbs every level below the root', () => {
  const chain = Array.from({ length: 200 }, (_, i) => ({ sessionId: `s${i}`, parentSession: i ? `s${i - 1}` : undefined }));
  const { absorbed } = computeAbsorption(chain);
  assert.equal(absorbed.size, 199);
  assert.equal(absorbed.has('s0'), false);
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

test('sessionGroups: a grandchild draws inside its root\'s group, in depth-first order', () => {
  const orch = { sessionId: 'orch' };
  const worker = { sessionId: 'worker', parentSession: 'orch' };
  const grand = { sessionId: 'grand', parentSession: 'worker' };
  const great = { sessionId: 'great', parentSession: 'grand' };
  const sibling = { sessionId: 'sibling', parentSession: 'orch' };
  const [g] = sessionGroups([orch, great, sibling, worker, grand]);
  assert.deepEqual(g.children.map((c) => c.sessionId), ['sibling', 'worker']);
  assert.deepEqual(g.descendants.map((c) => c.sessionId), ['sibling', 'worker', 'grand', 'great']);
});

test('sessionGroups: an orphan child stays top-level in its own slot', () => {
  const orphan = { sessionId: 'c', parentSession: 'elsewhere' };
  assert.deepEqual(groupIds([{ sessionId: 'a' }, orphan]), [['a', []], ['c', []]]);
});

const rowShape = (sessions, rootId) => {
  const { childrenByParent } = computeAbsorption(sessions);
  return spineRows(childrenByParent.get(rootId) || [], childrenByParent)
    .map((r) => [r.session.sessionId, r.depth, r.indent, r.more, r.guides]);
};

test('spineRows: flat children are depth 0, with `more` on all but the last', () => {
  const s = [{ sessionId: 'p' }, { sessionId: 'a', parentSession: 'p' }, { sessionId: 'b', parentSession: 'p' }];
  assert.deepEqual(rowShape(s, 'p'), [['a', 0, 0, true, []], ['b', 0, 0, false, []]]);
});

test('spineRows: a nested row steps in one level and carries the guide of an ancestor trunk still running', () => {
  const s = [
    { sessionId: 'p' },
    { sessionId: 'a', parentSession: 'p' },
    { sessionId: 'a1', parentSession: 'a' },
    { sessionId: 'a2', parentSession: 'a' },
    { sessionId: 'b', parentSession: 'p' },
  ];
  assert.deepEqual(rowShape(s, 'p'), [
    ['a', 0, 0, true, []],
    ['a1', 1, 1, true, [1]],
    ['a2', 1, 1, false, [1]],
    ['b', 0, 0, false, []],
  ]);
});

test('spineRows: an ancestor that is last at its level draws no guide for its descendants', () => {
  const s = [{ sessionId: 'p' }, { sessionId: 'a', parentSession: 'p' }, { sessionId: 'a1', parentSession: 'a' }];
  assert.deepEqual(rowShape(s, 'p'), [['a', 0, 0, false, []], ['a1', 1, 1, false, []]]);
});

test('spineRows: indent clamps at MAX_SPINE_INDENT while depth keeps counting', () => {
  const n = MAX_SPINE_INDENT + 3;
  const s = [{ sessionId: 'p' }, ...Array.from({ length: n }, (_, i) => ({ sessionId: `c${i}`, parentSession: i ? `c${i - 1}` : 'p' }))];
  const rows = rowShape(s, 'p');
  assert.equal(rows.length, n);
  assert.equal(rows[n - 1][1], n - 1);
  assert.equal(rows[n - 1][2], MAX_SPINE_INDENT);
});

test('spineRows: past the clamp a running ancestor trunk is kept as guide 0 so it reaches a later sibling', () => {
  const s = [{ sessionId: 'r' }];
  const chain = ['a', 'b', 'c'];
  chain.forEach((id, i) => s.push({ sessionId: id, parentSession: i ? chain[i - 1] : 'r' }));
  s.push({ sessionId: 'd', parentSession: 'c' }, { sessionId: 'e', parentSession: 'd' }, { sessionId: 'f', parentSession: 'e' }, { sessionId: 'z', parentSession: 'c' });
  const rows = Object.fromEntries(rowShape(s, 'r').map((r) => [r[0], r]));
  assert.equal(rows.d[2], MAX_SPINE_INDENT);
  assert.equal(rows.d[3], true);
  assert.deepEqual(rows.e[4], [0]);
  assert.deepEqual(rows.f[4], [0]);
  assert.equal(rows.z[3], false);
});

test('spineRows: a single-child chain keeps its trunk running through every row that has a child at the same capped indent', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const s = [{ sessionId: 'r' }, ...ids.map((id, i) => ({ sessionId: id, parentSession: i ? ids[i - 1] : 'r' }))];
  const rows = Object.fromEntries(rowShape(s, 'r').map((r) => [r[0], r]));
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((id) => rows[id][2]), [0, 1, 2, 3, 3]);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((id) => rows[id][3]), [false, false, false, true, false]);
});

test('spineRows: guides collapse onto one trunk once past the clamp', () => {
  const ids = Array.from({ length: MAX_SPINE_INDENT + 3 }, (_, i) => `c${i}`);
  const s = [{ sessionId: 'p' }];
  ids.forEach((id, i) => {
    s.push({ sessionId: id, parentSession: i ? ids[i - 1] : 'p' });
    s.push({ sessionId: `${id}x`, parentSession: i ? ids[i - 1] : 'p' });
  });
  const deepest = rowShape(s, 'p').find(([id]) => id === ids[ids.length - 1]);
  assert.equal(deepest[2], MAX_SPINE_INDENT);
  assert.equal(new Set(deepest[4]).size, deepest[4].length);
  assert.ok(deepest[4].every((up) => up >= 0 && up <= MAX_SPINE_INDENT));
});
