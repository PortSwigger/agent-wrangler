import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDispatch } from './dispatch-runner.js';

// Deps double recording the launch path (mirrors dispatch.test.js). The fake
// dispatch mints a fresh card id and runs the memory binder the way the real
// SessionManager does, so we can assert memory is bound BEFORE the card is
// assigned (the load-bearing ordering).
function deps(overrides = {}) {
  const calls = { dispatch: [], assign: [], bind: [] };
  return {
    calls,
    sessionManager: {
      entryFor: (id) => overrides.entries?.[id] ?? null,
      dispatch: async (opts) => {
        calls.dispatch.push(opts);
        opts.bindMemory?.('NEWCARD');
        return { sessionId: 'NEWCARD' };
      },
    },
    taskStore: { assign: (sid, taskId) => calls.assign.push({ sid, taskId }) },
    memoryStore: { bindSession: (sid, taskId) => calls.bind.push({ sid, taskId }) },
    ...overrides,
  };
}

test('plain dispatch: passes intent through, binds memory pre-launch, assigns the task', async () => {
  const d = deps();
  const { sessionId } = await runDispatch({ cwd: '/repo', intent: 'do it', taskId: 'T1' }, d);
  assert.equal(sessionId, 'NEWCARD');
  assert.equal(d.calls.dispatch[0].agent, 'claude');
  assert.equal(d.calls.dispatch[0].intent, 'do it');
  assert.equal(d.calls.dispatch[0].workflow, undefined);
  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T1' }]);
});

test('no taskId: binds memory to scratch and skips assign', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x' }, d);
  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: null }]);
  assert.deepEqual(d.calls.assign, []);
});

test('workflow: wraps the issue, forces an auto worktree, builds the marker', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'ENT-1234', workflow: true }, d, 123456);
  const opts = d.calls.dispatch[0];
  assert.match(opts.intent, /issue-to-pr skill/);
  assert.match(opts.intent, /Issue: ENT-1234/);
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeAuto, true);
  assert.match(opts.worktreeBranch, /ent-1234/); // seeded from the raw issue, not the wrapper
  assert.ok(opts.workflow);
  assert.equal(opts.workflow.issue, 'ENT-1234');
  assert.equal(opts.workflow.phase.label, 'starting');
  assert.equal(opts.workflow.phase.kind, 'active');
  assert.equal(opts.workflow.phase.at, 123456); // `now` threaded into the marker
});

test('manual worktree options pass through unchanged when not a workflow', async () => {
  const d = deps();
  await runDispatch({
    cwd: '/repo', intent: 'x', worktree: true, worktreeBranch: 'feat', worktreeFolderName: '/wt', worktreeAuto: false,
  }, d);
  const opts = d.calls.dispatch[0];
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeBranch, 'feat');
  assert.equal(opts.worktreeFolderName, '/wt');
  assert.equal(opts.worktreeAuto, false);
});

test('parentSession passes through when given, and is undefined when absent', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x', parentSession: 'SRC1' }, d);
  assert.equal(d.calls.dispatch[0].parentSession, 'SRC1');

  const d2 = deps();
  await runDispatch({ cwd: '/repo', intent: 'x' }, d2);
  assert.equal(d2.calls.dispatch[0].parentSession, undefined);
});

// Nesting only ever renders one level deep (see attachError's file comment in
// server/control/handlers/attach.js) — this guard keeps that true regardless
// of which path sets a brand-new parentSession (peer-review dispatch,
// spawn_session nest:true, a scheduled dispatch), not just Attach.
test('parentSession pointing at an already-nested session is refused before launch', async () => {
  const d = deps({ entries: { SRC1: { parentSession: 'ROOT' } } });
  await assert.rejects(
    () => runDispatch({ cwd: '/repo', intent: 'x', parentSession: 'SRC1' }, d),
    /itself nested/,
  );
  assert.equal(d.calls.dispatch.length, 0);
});

test('parentSession pointing at a top-level session is allowed', async () => {
  const d = deps({ entries: { SRC1: {} } });
  await runDispatch({ cwd: '/repo', intent: 'x', parentSession: 'SRC1' }, d);
  assert.equal(d.calls.dispatch[0].parentSession, 'SRC1');
});

test('addDirs defaults to [] when absent', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x' }, d);
  assert.deepEqual(d.calls.dispatch[0].addDirs, []);
});

test('effort passes through to sessionManager.dispatch', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x', effort: 'high' }, d);
  assert.equal(d.calls.dispatch[0].effort, 'high');
});

test('a launch failure propagates (callers own the error envelope)', async () => {
  const d = deps({ sessionManager: { dispatch: async () => { throw new Error('Branch feat already exists'); } } });
  await assert.rejects(() => runDispatch({ intent: 'x', worktree: true }, d), /Branch feat already exists/);
});
