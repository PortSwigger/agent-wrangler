import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { taskAssignHandler, taskCreateHandler, taskArchiveHandler, taskUnarchiveHandler, taskDeleteHandler, taskRenameHandler } from './tasks.js';

function ctx(overrides = {}) {
  const calls = {
    assign: [], bind: [], rebuild: 0, syncNotes: [], createTask: [], reply: [],
  };
  return {
    calls,
    reply: (msg) => calls.reply.push(msg),
    taskStore: {
      assign: (sid, taskId) => calls.assign.push({ sid, taskId }),
      createTask: (opts) => { calls.createTask.push(opts); return overrides.createdTask ?? { id: 'T1' }; },
    },
    // The `assign` launch context is how extensions (task-memory) re-point their
    // per-task state; what they granted is what a devcontainer session re-copies.
    sessionManager: {
      launchContext: async (sid, reason) => { calls.bind.push({ sid, reason }); return { env: {}, addDirs: [`/granted/${sid}`] }; },
      syncNotesToContainer: async (sid, { addDirs }) => { calls.syncNotes.push(sid); calls.synced = [...(calls.synced || []), ...addDirs]; },
    },
    graph: () => ({ sessions: overrides.sessions ?? [] }),
    rebuild: async () => { calls.rebuild += 1; },
    ...overrides.ctx,
  };
}

test('task-assign fires the assign launch context for the session', async () => {
  const c = ctx();
  await taskAssignHandler.handler({ type: 'task-assign', sessionId: 'S1', taskId: 'T2' }, c);
  assert.deepEqual(c.calls.assign, [{ sid: 'S1', taskId: 'T2' }]);
  assert.deepEqual(c.calls.bind, [{ sid: 'S1', reason: 'assign' }]);
  assert.deepEqual(c.calls.syncNotes, ['S1']); // re-copies the granted dirs into a devcontainer session's container, if any
  assert.deepEqual(c.calls.synced, ['/granted/S1']);
  assert.equal(c.calls.rebuild, 1);
});

test('task-assign with no taskId unassigns and still fires the assign context', async () => {
  const c = ctx();
  await taskAssignHandler.handler({ type: 'task-assign', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.assign, [{ sid: 'S1', taskId: null }]);
  assert.deepEqual(c.calls.bind, [{ sid: 'S1', reason: 'assign' }]);
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
  assert.deepEqual(c.calls.bind.map((b) => b.sid), ['S1', 'C1', 'GC1']);
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
  assert.deepEqual(c.calls.reply, [{ type: 'task-created', taskId: 'T1' }]);
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
      clearSnoozeDescendants: () => 0,
      snoozeGeneration: () => 0,
      resume: async (sid, dir) => { calls.resume.push({ sid, dir }); return { tmux: 'cc_new' }; },
    },
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

function deleteCtx({ unassigned = ['S1', 'S2'], fire } = {}) {
  const calls = { del: [], fired: [], order: [] };
  return {
    calls,
    taskStore: { deleteTask: (id) => { calls.order.push('core'); calls.del.push(id); return unassigned; } },
    ext: { fireTaskDelete: fire ?? (async (id) => { calls.order.push('ext'); calls.fired.push(id); }) },
    rebuild: async () => { calls.order.push('rebuild'); },
  };
}

test('task-delete: core removes the task first, then extensions are told, then the board rebuilds', async () => {
  const c = deleteCtx();
  await taskDeleteHandler.handler({ type: 'task-delete', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.order, ['core', 'ext', 'rebuild']);
  assert.deepEqual(c.calls.fired, ['T1']);
});

test('task-delete: an unknown task tells no extension', async () => {
  const c = deleteCtx({ unassigned: null });
  c.taskStore.deleteTask = () => null;
  await taskDeleteHandler.handler({ type: 'task-delete', taskId: 'nope' }, c);
  assert.deepEqual(c.calls.fired, []);
});

test('task-delete: works with no extension bag at all', async () => {
  const c = deleteCtx();
  delete c.ext;
  await taskDeleteHandler.handler({ type: 'task-delete', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.del, ['T1']);
});

async function draftContext(t, { assigned = true, moved = 'child' } = {}) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { TaskStore } = await import('../../task-store.js');
  const dir = mkdtempSync(join(os.tmpdir(), 'aw-task-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new TaskStore(join(dir, 'tasks.json'));
  const origin = store.createTask({ name: 'Original' });
  if (assigned) for (const sid of ['before', 'parent', 'child', 'grandchild', 'after']) store.assign(sid, origin.id);
  store.reorderSession(assigned ? origin.id : 'adhoc', ['before', 'parent', 'child', 'grandchild', 'after']);
  const sessions = [
    { sessionId: 'parent' },
    { sessionId: 'child', parentSession: 'parent' },
    { sessionId: 'grandchild', parentSession: 'child' },
  ];
  const initial = store.snapshot();
  const c = ctx({ sessions, ctx: {
    taskStore: store,
    sessionManager: {
      entryFor: (id) => sessions.find((s) => s.sessionId === id),
      detachSession: (id) => { delete sessions.find((s) => s.sessionId === id).parentSession; },
      attachSession: (id, parent) => { sessions.find((s) => s.sessionId === id).parentSession = parent; },
    },
  } });
  await taskCreateHandler.handler({ type: 'task-create', sessionId: moved, draft: true }, c);
  const taskId = c.calls.reply[0].taskId;
  return { c, store, sessions, initial, taskId, origin };
}

for (const assigned of [true, false]) for (const moved of ['parent', 'child']) test(`cancelling a draft restores ${moved} and descendants to ${assigned ? 'their task' : 'Unassigned'}, in order`, async (t) => {
  const { c, store, sessions, initial, taskId } = await draftContext(t, { assigned, moved });
  assert.equal(store.taskFor('child').id, taskId);
  assert.equal(store.taskFor('grandchild').id, taskId);
  assert.equal(sessions[1].parentSession, moved === 'child' ? undefined : 'parent');
  await taskDeleteHandler.handler({ type: 'task-delete', taskId, undoCreate: true }, c);
  assert.deepEqual(store.snapshot(), initial);
  assert.equal(sessions[1].parentSession, 'parent');
  assert.equal(sessions[2].parentSession, 'child');
  const { TaskStore } = await import('../../task-store.js');
  assert.deepEqual(new TaskStore(store.file).snapshot(), initial);
});

for (const mutation of ['archive origin', 'move parent', 'add member']) test(`cancellation refuses ${mutation} without partially undoing the move`, async (t) => {
  const { c, store, taskId, origin } = await draftContext(t);
  if (mutation === 'archive origin') store.archiveTask(origin.id);
  if (mutation === 'move parent') store.assign('parent', taskId);
  if (mutation === 'add member') store.assign('new-member', taskId);
  const before = store.snapshot();
  await assert.rejects(taskDeleteHandler.handler({ type: 'task-delete', taskId, undoCreate: true }, c));
  assert.deepEqual(store.snapshot(), before);
});

test('accepted initial naming clears rollback state', async (t) => {
  const { c, store, taskId } = await draftContext(t);
  await taskRenameHandler.handler({ type: 'task-rename', taskId, name: 'New task' }, c);
  const before = store.snapshot();
  await assert.rejects(taskDeleteHandler.handler({ type: 'task-delete', taskId, undoCreate: true }, c), /no longer be cancelled/);
  assert.deepEqual(store.snapshot(), before);
});

test('a different connection cannot cancel a draft', async (t) => {
  const { c, store, taskId } = await draftContext(t);
  const before = store.snapshot();
  await assert.rejects(taskDeleteHandler.handler({ type: 'task-delete', taskId, undoCreate: true }, { ...c, reply() {} }));
  assert.deepEqual(store.snapshot(), before);
});

test('cancelling without a draft snapshot refuses to delete the task', async () => {
  const c = ctx({ ctx: { taskStore: { deleteTask() { assert.fail('must not delete without rollback state'); } } } });
  await assert.rejects(taskDeleteHandler.handler({ type: 'task-delete', taskId: 'T1', undoCreate: true }, c), /no longer be cancelled/);
});

test('cancellation preserves a concurrent reorder of sessions left in the original task', async (t) => {
  const { c, store, taskId, origin } = await draftContext(t);
  store.reorderSession(origin.id, ['after', 'parent', 'before']);
  await taskDeleteHandler.handler({ type: 'task-delete', taskId, undoCreate: true }, c);
  assert.deepEqual(store.snapshot().sessionOrder[origin.id], ['after', 'parent', 'child', 'grandchild', 'before']);
});

test('a failed descendant move rolls back the partially created draft', async (t) => {
  const { c, store } = await draftContext(t);
  const before = store.snapshot();
  const assign = store.assign.bind(store);
  let failed = false;
  store.assign = (sid, tid) => {
    if (sid === 'grandchild' && !failed) { failed = true; throw new Error('move failed'); }
    return assign(sid, tid);
  };
  await assert.rejects(taskCreateHandler.handler({ type: 'task-create', sessionId: 'child', draft: true }, c), /move failed/);
  assert.deepEqual(store.snapshot(), before);
});

test('draft creation refuses workflow workers before creating or moving anything', async () => {
  const entries = { child: { parentSession: 'parent' }, parent: { workflow: 'run' } };
  const c = ctx({ ctx: { sessionManager: { entryFor: (sid) => entries[sid] } } });
  await assert.rejects(taskCreateHandler.handler({ type: 'task-create', sessionId: 'child', draft: true }, c), /workflow worker/);
  assert.deepEqual(c.calls.createTask, []);
  assert.deepEqual(c.calls.assign, []);
});

test('cancelling an empty draft deletes only that task', async (t) => {
  const { c, store } = await draftContext(t);
  const before = store.snapshot();
  await taskCreateHandler.handler({ type: 'task-create', draft: true }, c);
  const taskId = c.calls.reply.at(-1).taskId;
  await taskDeleteHandler.handler({ type: 'task-delete', taskId, undoCreate: true }, c);
  assert.deepEqual(store.snapshot(), before);
});
