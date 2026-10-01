import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSessionTool } from './assign-session.js';

// A deps double recording assign/launchContext/rebuild calls. CARD1/CARD2 have
// mapping entries; T1 is the only valid task.
function deps() {
  const calls = { assign: [], bind: [], rebuild: 0 };
  const assignments = {};
  const d = {
    sessionManager: {
      entryFor: (id) => (id === 'CARD1' || id === 'CARD2' ? { short: 'x' } : null),
      // The `assign` launch context is how extensions (task-memory) re-point
      // per-task state; recorded with the task the store held at that moment.
      launchContext: async (sessionId, reason) => { calls.bind.push({ sessionId, reason, taskId: d.taskStore.taskFor(sessionId)?.id ?? null }); },
    },
    taskStore: {
      assign: (sessionId, taskId) => {
        calls.assign.push({ sessionId, taskId });
        if (taskId && taskId !== 'T1') return false;
        assignments[sessionId] = taskId;
        return true;
      },
      taskFor: (sessionId) => {
        const id = assignments[sessionId];
        return id ? { id, name: 'Login' } : null;
      },
    },
    rebuild: async () => { calls.rebuild += 1; },
  };
  return { d, calls };
}

test('assign_session assigns an explicit target to a known task', async () => {
  const { d, calls } = deps();
  const out = await assignSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2', task_id: 'T1' });
  assert.deepEqual(out.structuredContent, { target: 'CARD2', task: { id: 'T1', name: 'Login' } });
  assert.deepEqual(calls.assign, [{ sessionId: 'CARD2', taskId: 'T1' }]);
  assert.deepEqual(calls.bind, [{ sessionId: 'CARD2', reason: 'assign', taskId: 'T1' }]); // after the assign landed
  assert.equal(calls.rebuild, 1);
});

test('assign_session defaults target to the caller', async () => {
  const { d, calls } = deps();
  const out = await assignSessionTool.handler({ deps: d, caller: 'CARD1' }, { task_id: 'T1' });
  assert.equal(out.structuredContent.target, 'CARD1');
  assert.deepEqual(calls.assign, [{ sessionId: 'CARD1', taskId: 'T1' }]);
});

test('assign_session with no task_id unassigns back to Ad-hoc', async () => {
  const { d, calls } = deps();
  const out = await assignSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2' });
  assert.deepEqual(out.structuredContent, { target: 'CARD2', task: null });
  assert.deepEqual(calls.assign, [{ sessionId: 'CARD2', taskId: null }]);
  assert.deepEqual(calls.bind, [{ sessionId: 'CARD2', reason: 'assign', taskId: null }]);
});

test('assign_session with task_id: null unassigns back to Ad-hoc', async () => {
  const { d, calls } = deps();
  const out = await assignSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2', task_id: null });
  assert.deepEqual(out.structuredContent.task, null);
  assert.deepEqual(calls.assign, [{ sessionId: 'CARD2', taskId: null }]);
});

test('assign_session rejects an unknown task id without firing the assign context or rebuilding', async () => {
  const { d, calls } = deps();
  const out = await assignSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2', task_id: 'GHOST' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown task/);
  assert.equal(calls.bind.length, 0);
  assert.equal(calls.rebuild, 0);
});

test('assign_session rejects an unknown target session', async () => {
  const { d, calls } = deps();
  const out = await assignSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'GHOST', task_id: 'T1' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown session/);
  assert.equal(calls.assign.length, 0);
});

test('assign_session with no caller and no target errors rather than guessing', async () => {
  const { d, calls } = deps();
  const out = await assignSessionTool.handler({ deps: d, caller: null }, { task_id: 'T1' });
  assert.equal(out.isError, true);
  assert.equal(calls.assign.length, 0);
});

test('assign_session fires the assign context for the target and every descendant, each after its own assign', async () => {
  const { d, calls } = deps();
  d.graph = () => ({ sessions: [{ sessionId: 'CARD2' }, { sessionId: 'KID', parentSession: 'CARD2' }, { sessionId: 'GRANDKID', parentSession: 'KID' }, { sessionId: 'OTHER' }] });
  await assignSessionTool.handler({ deps: d, caller: 'CARD1' }, { target: 'CARD2', task_id: 'T1' });
  assert.deepEqual(calls.bind.map((b) => [b.sessionId, b.reason, b.taskId]), [
    ['CARD2', 'assign', 'T1'], ['KID', 'assign', 'T1'], ['GRANDKID', 'assign', 'T1'],
  ]);
});
