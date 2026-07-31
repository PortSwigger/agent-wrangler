import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchHandler } from './dispatch.js';

// A ctx double recording the launch path. The fake dispatch mints a fresh card id
// and runs the memory binder the way the real SessionManager does, so we can assert
// memory is bound BEFORE the card is assigned (the load-bearing ordering).
function ctx(overrides = {}) {
  const calls = { dispatch: [], assign: [], bind: [], rebuild: 0, sent: [] };
  return {
    calls,
    sessionManager: {
      dispatch: async (opts) => {
        calls.dispatch.push(opts);
        opts.bindMemory?.('NEWCARD');
        return { sessionId: 'NEWCARD' };
      },
    },
    taskStore: { assign: (sid, taskId) => calls.assign.push({ sid, taskId }) },
    memoryStore: { bindSession: (sid, taskId) => calls.bind.push({ sid, taskId }) },
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.sent.push(obj),
    ...overrides,
  };
}

test('dispatch binds memory pre-launch, assigns the task, then acks', async () => {
  const c = ctx();
  await dispatchHandler.handler({ type: 'dispatch', cwd: '/repo', intent: 'do it', taskId: 'T1' }, c);

  assert.equal(c.calls.dispatch.length, 1);
  assert.equal(c.calls.dispatch[0].agent, 'claude');
  // Memory bound to the chosen task during dispatch (pre-launch), then assigned.
  assert.deepEqual(c.calls.bind, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.deepEqual(c.calls.assign, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.equal(c.calls.rebuild, 1);
  assert.deepEqual(c.calls.sent, [{ type: 'dispatched', sessionId: 'NEWCARD' }]);
});

test('dispatch with no taskId binds memory to scratch and skips assign', async () => {
  const c = ctx();
  await dispatchHandler.handler({ type: 'dispatch', cwd: '/repo', intent: 'x' }, c);
  assert.deepEqual(c.calls.bind, [{ sid: 'NEWCARD', taskId: null }]);
  assert.deepEqual(c.calls.assign, []);
});

test('dispatch with workflow wraps the issue, forces an auto worktree, forwards the marker', async () => {
  const c = ctx();
  await dispatchHandler.handler({ type: 'dispatch', cwd: '/repo', intent: 'ENT-1234', workflow: true, taskId: 'T1' }, c);
  const opts = c.calls.dispatch[0];
  assert.match(opts.intent, /issue-to-pr skill/); // skill-naming wrapper, not bare prose
  assert.match(opts.intent, /Issue: ENT-1234/);
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeAuto, true);
  assert.ok(opts.workflow, 'workflow marker forwarded');
  assert.equal(opts.workflow.issue, 'ENT-1234');
  assert.equal(opts.workflow.phase.label, 'starting');
  assert.equal(opts.workflow.phase.kind, 'active');
  // The branch is seeded from the raw issue (a clean slug), not the wrapped prompt.
  assert.match(opts.worktreeBranch, /ent-1234/);
});

test('dispatch without workflow passes the intent through unwrapped and stamps no marker', async () => {
  const c = ctx();
  await dispatchHandler.handler({ type: 'dispatch', cwd: '/repo', intent: 'just do it' }, c);
  const opts = c.calls.dispatch[0];
  assert.equal(opts.intent, 'just do it');
  assert.equal(opts.workflow, undefined);
});

test('dispatch surfaces a launch failure as an error frame without acking', async () => {
  const c = ctx({
    sessionManager: { dispatch: async () => { throw new Error('Branch feat already exists'); } },
  });
  await dispatchHandler.handler({ type: 'dispatch', intent: 'x', worktree: true }, c);
  assert.deepEqual(c.calls.sent, [{ type: 'error', message: 'Branch feat already exists' }]);
  assert.equal(c.calls.rebuild, 0);
});
