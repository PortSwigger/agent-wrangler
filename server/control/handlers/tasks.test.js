import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskAssignHandler, taskDeleteHandler, taskRestoreHandler } from './tasks.js';

function ctx(overrides = {}) {
  const calls = { assign: [], bind: [], rebuild: 0, deleteTask: [], restoreTask: [], syncNotes: [] };
  return {
    calls,
    taskStore: {
      assign: (sid, taskId) => calls.assign.push({ sid, taskId }),
      deleteTask: () => { calls.deleteTask.push(true); return overrides.snap ?? null; },
      restoreTask: (snap) => { calls.restoreTask.push(snap); return overrides.restoreOk ?? false; },
    },
    memoryStore: { bindSession: (sid, taskId) => calls.bind.push({ sid, taskId }) },
    sessionManager: { syncNotesToContainer: async (sid) => { calls.syncNotes.push(sid); } },
    pendingTaskRestores: new Map(),
    rebuild: async () => { calls.rebuild += 1; },
    ...overrides.ctx,
  };
}

test('task-assign repoints the session memory link to the new task', async () => {
  const c = ctx();
  await taskAssignHandler.handler({ type: 'task-assign', sessionId: 'S1', taskId: 'T2' }, c);
  assert.deepEqual(c.calls.assign, [{ sid: 'S1', taskId: 'T2' }]);
  assert.deepEqual(c.calls.bind, [{ sid: 'S1', taskId: 'T2' }]);
  assert.deepEqual(c.calls.syncNotes, ['S1']); // re-copies notes into a devcontainer session's container, if any
  assert.equal(c.calls.rebuild, 1);
});

test('task-assign with no taskId unassigns and points memory at scratch', async () => {
  const c = ctx();
  await taskAssignHandler.handler({ type: 'task-assign', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.assign, [{ sid: 'S1', taskId: null }]);
  assert.deepEqual(c.calls.bind, [{ sid: 'S1', taskId: null }]);
});

test('task-delete stashes the snapshot and points freed sessions at scratch', async () => {
  const snap = { assignments: { S1: 'T1', S2: 'T1' } };
  const c = ctx({ snap });
  await taskDeleteHandler.handler({ type: 'task-delete', taskId: 'T1' }, c);
  assert.equal(c.pendingTaskRestores.get('T1'), snap);
  assert.deepEqual(c.calls.bind, [{ sid: 'S1', taskId: null }, { sid: 'S2', taskId: null }]);
});

test('task-restore relinks each session back to the recovered task', async () => {
  const snap = { assignments: { S1: 'T1', S2: 'T1' } };
  const c = ctx({ snap, restoreOk: true });
  c.pendingTaskRestores.set('T1', snap);
  await taskRestoreHandler.handler({ type: 'task-restore', taskId: 'T1' }, c);
  assert.equal(c.pendingTaskRestores.has('T1'), false);
  assert.deepEqual(c.calls.bind, [{ sid: 'S1', taskId: 'T1' }, { sid: 'S2', taskId: 'T1' }]);
});
