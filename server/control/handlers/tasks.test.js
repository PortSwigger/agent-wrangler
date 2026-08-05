import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { taskAssignHandler, taskCreateHandler, taskArchiveHandler, taskUnarchiveHandler } from './tasks.js';

function ctx(overrides = {}) {
  const calls = {
    assign: [], bind: [], rebuild: 0, syncNotes: [], createTask: [],
  };
  return {
    calls,
    taskStore: {
      assign: (sid, taskId) => calls.assign.push({ sid, taskId }),
      createTask: (opts) => { calls.createTask.push(opts); return overrides.createdTask ?? { id: 'T1' }; },
    },
    memoryStore: { bindSession: (sid, taskId) => calls.bind.push({ sid, taskId }) },
    sessionManager: { syncNotesToContainer: async (sid) => { calls.syncNotes.push(sid); } },
    graph: () => ({ sessions: overrides.sessions ?? [] }),
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

test('task-assign moves a dragged parent\'s whole transitive family to the new task', async () => {
  const sessions = [
    { sessionId: 'S1' }, // dragged parent
    { sessionId: 'C1', parentSession: 'S1' }, // direct child
    { sessionId: 'GC1', parentSession: 'C1' }, // chained grandchild
    { sessionId: 'S2' }, // unrelated — must not move
  ];
  const c = ctx({ sessions });
  await taskAssignHandler.handler({ type: 'task-assign', sessionId: 'S1', taskId: 'T2' }, c);
  assert.deepEqual(c.calls.assign, [
    { sid: 'S1', taskId: 'T2' }, { sid: 'C1', taskId: 'T2' }, { sid: 'GC1', taskId: 'T2' },
  ]);
  assert.deepEqual(c.calls.bind, [
    { sid: 'S1', taskId: 'T2' }, { sid: 'C1', taskId: 'T2' }, { sid: 'GC1', taskId: 'T2' },
  ]);
  assert.deepEqual(c.calls.syncNotes, ['S1', 'C1', 'GC1']);
  assert.equal(c.calls.rebuild, 1); // one rebuild for the whole family, not one per session
});

test('task-assign to Ad-hoc (no taskId) pushes null to the family too', async () => {
  const sessions = [{ sessionId: 'S1' }, { sessionId: 'C1', parentSession: 'S1' }];
  const c = ctx({ sessions });
  await taskAssignHandler.handler({ type: 'task-assign', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.assign, [{ sid: 'S1', taskId: null }, { sid: 'C1', taskId: null }]);
});

test('task-create seeded with a parent-with-children assigns the whole family to the new task', async () => {
  const sessions = [
    { sessionId: 'S1' },
    { sessionId: 'C1', parentSession: 'S1' },
    { sessionId: 'S2' }, // unrelated — must not move
  ];
  const c = ctx({ sessions, createdTask: { id: 'T9' } });
  await taskCreateHandler.handler({ type: 'task-create', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.createTask, [{ name: undefined, sessionId: 'S1' }]);
  assert.deepEqual(c.calls.assign, [{ sid: 'C1', taskId: 'T9' }]); // createTask itself seeds S1
  assert.equal(c.calls.rebuild, 1);
});

test('task-create with no sessionId (plain "+ New task") does not touch taskStore.assign', async () => {
  const c = ctx();
  await taskCreateHandler.handler({ type: 'task-create' }, c);
  assert.deepEqual(c.calls.assign, []);
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

test('task-unarchive: calls taskStore.unarchiveTask, rebuilds, and acks task-unarchived', async () => {
  const c = archiveCtx();
  await taskUnarchiveHandler.handler({ type: 'task-unarchive', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.unarchiveTask, ['T1']);
  assert.equal(c.calls.rebuild, 1);
  assert.deepEqual(c.calls.reply, [{ type: 'task-unarchived', taskId: 'T1' }]);
});

test('task-unarchive: an unknown/not-archived taskId (unarchiveTask returns false) just rebuilds — no ack, no resume', async () => {
  const c = archiveCtx();
  c.taskStore.unarchiveTask = (id) => { c.calls.unarchiveTask.push(id); return false; };
  await taskUnarchiveHandler.handler({ type: 'task-unarchive', taskId: 'GHOST' }, c);
  assert.deepEqual(c.calls.reply, []);
  assert.equal(c.calls.rebuild, 1);
});

test('task-unarchive: without restoreSessions, resumes nothing even if sessions are still cascade-archived', async () => {
  const c = archiveCtx();
  c.sessionManager.archivedEntries = () => [{ sessionId: 'S1', viaTaskArchive: 'T1' }];
  c.sessionManager.resume = async () => { throw new Error('must not resume'); };
  await taskUnarchiveHandler.handler({ type: 'task-unarchive', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.reply, [{ type: 'task-unarchived', taskId: 'T1' }]);
});

// A fuller ctx for the restoreSessions:true path — taskUnarchiveHandler funnels
// each cascaded session through the REAL resumeSession (imported, not injected),
// so this must satisfy its whole contract (mirrors resume.test.js's handlerCtx).
function unarchiveCtx({ archivedEntries = [] } = {}) {
  const calls = { unarchiveTask: [], reply: [], rebuild: 0, resume: [], bind: [], unassign: [] };
  const entriesById = new Map(archivedEntries.map((e) => [e.sessionId, e]));
  return {
    calls,
    taskStore: {
      unarchiveTask: (id) => { calls.unarchiveTask.push(id); return true; },
      isAssignedToArchivedTask: () => false, // the task was just unarchived above
      unassign: (sid) => calls.unassign.push(sid),
      taskFor: () => null,
    },
    sessionManager: {
      archivedEntries: () => archivedEntries,
      entryFor: (sid) => entriesById.get(sid),
      clearSnooze: () => true,
      resume: async (sid, dir) => { calls.resume.push({ sid, dir }); return { tmux: 'cc_new' }; },
    },
    memoryStore: { bindSession: (sid, taskId) => calls.bind.push({ sid, taskId }) },
    sessionFromGraph: () => null, // archived sessions are off the live graph
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.reply.push(obj),
  };
}

test('task-unarchive: restoreSessions resumes exactly the sessions cascaded with THIS task, sequentially, and none other', async () => {
  const dir = os.tmpdir();
  const c = unarchiveCtx({
    archivedEntries: [
      { sessionId: 'S1', viaTaskArchive: 'T1', cwd: dir },
      { sessionId: 'S2', viaTaskArchive: 'T2', cwd: dir }, // a different task's cascade — must not resume
      { sessionId: 'S3', cwd: dir }, // independently archived, no viaTaskArchive — must not resume
      { sessionId: 'S4', viaTaskArchive: 'T1', cwd: dir },
    ],
  });
  await taskUnarchiveHandler.handler({ type: 'task-unarchive', taskId: 'T1', restoreSessions: true }, c);
  assert.deepEqual(c.calls.resume.map((r) => r.sid), ['S1', 'S4']);
  assert.deepEqual(c.calls.reply, [{ type: 'task-unarchived', taskId: 'T1' }]);
});
