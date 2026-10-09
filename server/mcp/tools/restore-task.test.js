import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreTaskTool } from './restore-task.js';

function deps() {
  const calls = { resume: [], unarchive: [] };
  const entries = { A: { viaTaskArchive: 'T1', archivedAt: 1 }, B: { viaTaskArchive: 'T2', archivedAt: 2 } };
  return {
    calls,
    taskStore: {
      tasks: [{ id: 'T1', archivedAt: 5 }, { id: 'T2' }],
      unarchiveTask: (id) => { calls.unarchive.push(id); return true; },
      isAssignedToArchivedTask: () => false,
      unassign() {},
    },
    sessionManager: {
      archivedEntries: () => Object.entries(entries).map(([sessionId, e]) => ({ sessionId, ...e })),
      entryFor: (id) => entries[id],
      clearSnooze: () => false,
      resume: async (id) => { calls.resume.push(id); return { tmux: 't' }; },
    },
    sessionFromGraph: () => null,
    rebuild: async () => {},
  };
}

test('unarchives the task and resumes only its cascaded sessions', async () => {
  const d = deps();
  const out = await restoreTaskTool.handler({ deps: d }, { task_id: 'T1' });
  assert.deepEqual(d.calls.unarchive, ['T1']);
  assert.deepEqual(d.calls.resume, ['A']);
  assert.deepEqual(out.structuredContent.restored_sessions, ['A']);
});

test('restore_sessions: false brings back only the task', async () => {
  const d = deps();
  await restoreTaskTool.handler({ deps: d }, { task_id: 'T1', restore_sessions: false });
  assert.deepEqual(d.calls.resume, []);
});

test('rejects unknown and non-archived tasks', async () => {
  assert.equal((await restoreTaskTool.handler({ deps: deps() }, { task_id: 'zz' })).isError, true);
  assert.match((await restoreTaskTool.handler({ deps: deps() }, { task_id: 'T2' })).content[0].text, /not archived/);
});
