import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskAssignHandler, taskDeleteHandler, taskRestoreHandler, taskArchiveHandler, taskUnarchiveHandler } from './tasks.js';

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

// A fuller ctx for task-archive: it calls the REAL archiveCascade (imported, not
// injected), so this must satisfy that helper's own contract too — modeled on
// archive.test.js's cascadeCtx, plus taskStore.archiveTask/snapshot/unarchiveTask.
function archiveCtx({ archiveOk = true, assignments = {}, sessions = [], archivedSessionIds = new Set() } = {}) {
  const calls = { archiveTask: [], unarchiveTask: [], kill: [], archive: [], reply: [], rebuild: 0 };
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  return {
    calls,
    taskStore: {
      archiveTask: (id) => { calls.archiveTask.push(id); return archiveOk; },
      unarchiveTask: (id) => { calls.unarchiveTask.push(id); return true; },
      snapshot: () => ({ assignments }),
      taskFor: () => null,
    },
    sessionManager: {
      isArchived: (sid) => archivedSessionIds.has(sid),
      killForSession: async (sid) => { calls.kill.push(sid); return []; },
      archive: (sid, meta) => calls.archive.push({ sid, meta }),
    },
    sessionFromGraph: (sid) => byId.get(sid) ?? null,
    graph: () => ({ sessions }),
    tmuxFor: (sid) => byId.get(sid)?.tmux ?? null,
    socketFor: () => '',
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.reply.push(obj),
  };
}

test('task-archive: cascades every LIVE session directly assigned to the task, replies with the count', async () => {
  const c = archiveCtx({
    assignments: { S1: 'T1', S2: 'T1', S3: 'T2' }, // S3 belongs to a different task
    sessions: [{ sessionId: 'S1', cwd: '/x' }, { sessionId: 'S2', cwd: '/x' }, { sessionId: 'S3', cwd: '/x' }],
  });
  await taskArchiveHandler.handler({ type: 'task-archive', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.archiveTask, ['T1']);
  assert.deepEqual(c.calls.kill.sort(), ['S1', 'S2']);
  assert.deepEqual(c.calls.archive.map((a) => a.sid).sort(), ['S1', 'S2']);
  assert.deepEqual(c.calls.reply, [{ type: 'task-archived', taskId: 'T1', unclean: false, archivedSessions: 2 }]);
});

test('task-archive: excludes a session already archived (no double-teardown)', async () => {
  const c = archiveCtx({
    assignments: { S1: 'T1', S2: 'T1' },
    sessions: [{ sessionId: 'S1', cwd: '/x' }, { sessionId: 'S2', cwd: '/x' }],
    archivedSessionIds: new Set(['S2']),
  });
  await taskArchiveHandler.handler({ type: 'task-archive', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.kill, ['S1']);
  assert.deepEqual(c.calls.reply, [{ type: 'task-archived', taskId: 'T1', unclean: false, archivedSessions: 1 }]);
});

test('task-archive: an empty task (no assigned sessions) still archives and replies with 0', async () => {
  const c = archiveCtx({ assignments: {}, sessions: [] });
  await taskArchiveHandler.handler({ type: 'task-archive', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.kill, []);
  assert.deepEqual(c.calls.reply, [{ type: 'task-archived', taskId: 'T1', unclean: false, archivedSessions: 0 }]);
});

test('task-archive: unknown/already-archived taskId (archiveTask returns false) just rebuilds — no cascade, no reply', async () => {
  const c = archiveCtx({ archiveOk: false, assignments: { S1: 'T1' }, sessions: [{ sessionId: 'S1', cwd: '/x' }] });
  await taskArchiveHandler.handler({ type: 'task-archive', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.kill, []);
  assert.deepEqual(c.calls.reply, []);
  assert.equal(c.calls.rebuild, 1);
});

test('task-unarchive: calls taskStore.unarchiveTask and rebuilds', async () => {
  const c = archiveCtx();
  await taskUnarchiveHandler.handler({ type: 'task-unarchive', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.unarchiveTask, ['T1']);
  assert.equal(c.calls.rebuild, 1);
});
