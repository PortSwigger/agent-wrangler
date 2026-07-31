import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendantsOf, cascadeSummary, cascadeDialogBody, worktreeStillInUse, containerStillInUse } from './archive-cascade.js';

test('descendantsOf: walks the transitive parentSession chain, not just direct children', () => {
  const sessions = [
    { sessionId: 'ORCH' },
    { sessionId: 'C1', parentSession: 'ORCH' },
    { sessionId: 'GC1', parentSession: 'C1' },
    { sessionId: 'OTHER' },
  ];
  assert.deepEqual(descendantsOf('ORCH', sessions).map((s) => s.sessionId), ['C1', 'GC1']);
});

test('descendantsOf: no descendants → empty array', () => {
  assert.deepEqual(descendantsOf('X', [{ sessionId: 'X' }]), []);
});

test('cascadeSummary: counts descendants, flags a background shell anywhere in the set (target included)', () => {
  const target = { sessionId: 'ORCH', hasBackgroundShell: true };
  const sessions = [target, { sessionId: 'C1', parentSession: 'ORCH' }];
  const summary = cascadeSummary(target, sessions);
  assert.equal(summary.count, 1);
  assert.equal(summary.hasBackgroundShell, true);
  assert.equal(summary.needsYou, 0);
});

test('cascadeSummary: flags a background shell on a DESCENDANT even when the target has none', () => {
  const target = { sessionId: 'ORCH' };
  const sessions = [target, { sessionId: 'C1', parentSession: 'ORCH', hasBackgroundShell: true }];
  assert.equal(cascadeSummary(target, sessions).hasBackgroundShell, true);
});

test('cascadeSummary: counts descendants sitting in needs-you', () => {
  const target = { sessionId: 'ORCH' };
  const sessions = [
    target,
    { sessionId: 'C1', parentSession: 'ORCH', status: 'needs-you' },
    { sessionId: 'C2', parentSession: 'ORCH', status: 'working' },
  ];
  assert.equal(cascadeSummary(target, sessions).needsYou, 1);
});

test('cascadeDialogBody: names the count and flags a background job and a needs-you descendant', () => {
  const target = { sessionId: 'ORCH' };
  const sessions = [
    target,
    { sessionId: 'C1', parentSession: 'ORCH', hasBackgroundShell: true },
    { sessionId: 'C2', parentSession: 'ORCH', status: 'needs-you' },
  ];
  const body = cascadeDialogBody(target, sessions);
  assert.match(body, /2 connected sessions/);
  assert.match(body, /background job running/);
  assert.match(body, /1 is waiting on your input/);
});

test('cascadeDialogBody: no extra flags when nothing risky is present', () => {
  const target = { sessionId: 'ORCH' };
  const sessions = [target, { sessionId: 'C1', parentSession: 'ORCH' }];
  const body = cascadeDialogBody(target, sessions);
  assert.match(body, /1 connected session /); // singular
  assert.doesNotMatch(body, /background job/);
  assert.doesNotMatch(body, /waiting on your input/);
});

test('worktreeStillInUse: true when another (non-ignored) session shares the exact cwd', () => {
  const sessions = [{ sessionId: 'A', cwd: '/wt' }, { sessionId: 'B', cwd: '/wt' }];
  assert.equal(worktreeStillInUse('/wt', sessions, ['A']), true);
});

test('worktreeStillInUse: false once every session at that cwd is in the ignore list (a completed cascade)', () => {
  const sessions = [{ sessionId: 'A', cwd: '/wt' }, { sessionId: 'B', cwd: '/wt' }];
  assert.equal(worktreeStillInUse('/wt', sessions, ['A', 'B']), false);
});

test('worktreeStillInUse: false when no other session shares the cwd', () => {
  const sessions = [{ sessionId: 'A', cwd: '/wt' }, { sessionId: 'B', cwd: '/other' }];
  assert.equal(worktreeStillInUse('/wt', sessions, ['A']), false);
});

test('containerStillInUse: true when another (non-ignored) devcontainer session shares the exact cwd', () => {
  const sessions = [{ sessionId: 'A', runtime: 'devcontainer', cwd: '/repo' }, { sessionId: 'B', runtime: 'devcontainer', cwd: '/repo' }];
  assert.equal(containerStillInUse('/repo', sessions, ['A']), true);
});

test('containerStillInUse: false once every devcontainer session at that cwd is ignored (a completed archive)', () => {
  const sessions = [{ sessionId: 'A', runtime: 'devcontainer', cwd: '/repo' }, { sessionId: 'B', runtime: 'devcontainer', cwd: '/repo' }];
  assert.equal(containerStillInUse('/repo', sessions, ['A', 'B']), false);
});

test('containerStillInUse: a HOST session at the same cwd does not count (it uses no container)', () => {
  const sessions = [{ sessionId: 'A', runtime: 'devcontainer', cwd: '/repo' }, { sessionId: 'H', runtime: null, cwd: '/repo' }];
  assert.equal(containerStillInUse('/repo', sessions, ['A']), false);
});

test('containerStillInUse: false when the only other devcontainer session is at a different cwd', () => {
  const sessions = [{ sessionId: 'A', runtime: 'devcontainer', cwd: '/repo' }, { sessionId: 'B', runtime: 'devcontainer', cwd: '/other' }];
  assert.equal(containerStillInUse('/repo', sessions, ['A']), false);
});
