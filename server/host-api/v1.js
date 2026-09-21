import { projectSession, projectTask } from './project.js';

// One builder per v1 capability. A builder receives the wiring bag index.js
// composed (the core singletons plus the board primitives) and returns the
// sub-object to merge onto the façade — so these functions are the ONLY place a
// singleton is touched on an extension's behalf, and a capability an extension
// did not declare has no builder run for it and therefore no key at all.
//
// Every builder is a THIN bind over a primitive the core already owns. That is
// the point: the vocabulary is closed and declared, not a second implementation
// of session lifecycle that can drift from the board's.
//
// THREE FORCED VALUES live here — `broadcast`'s `type`, `mail.send`'s `from`,
// and `wake`/`kill`'s `reason`. All three are closed over from the extension's
// own id and are not caller-passable: narrowness of signature IS the access
// control (the same reasoning as createExtDeliver's two arguments and the
// checklist tools' missing `session` parameter), because a runtime check the
// caller can pass a value through is not a control at all. An extension can
// never impersonate the core, or another extension, on any of the three.

const sessionsRead = ({ core }) => ({
  sessions: {
    list: () => core.sessionManager.activeEntries()
      .map((e) => projectSession(e, e.sessionId, { taskId: core.taskStore.taskFor(e.sessionId)?.id ?? null })),
    get: (id) => {
      const e = core.sessionManager.entryFor(id);
      return e ? projectSession(e, id, { taskId: core.taskStore.taskFor(id)?.id ?? null }) : null;
    },
    forTask: (taskId) => core.sessionManager.activeEntries()
      .filter((e) => core.taskStore.taskFor(e.sessionId)?.id === taskId)
      .map((e) => projectSession(e, e.sessionId, { taskId })),
  },
});

const sessionsWake = ({ id, core }) => ({
  sessions: {
    // reason FORCED: the resume log line exists to name WHAT woke a card, so
    // `ext:checklist` is the whole value of the line — a shared 'extension'
    // (what the pre-façade bag passed) names nothing, and a caller-supplied one
    // could claim 'message' and read as a human pressing send.
    wake: (sid, { cwd } = {}) => core.sessionManager.resume(sid, cwd, { reason: `ext:${id}` }),
  },
});

const sessionsArchive = ({ archiveSession }) => ({
  sessions: {
    archive: (sid, { cascade = true } = {}) => archiveSession(sid, { cascade }),
  },
});

const sessionsSpawn = ({ core }) => ({
  sessions: {
    // `parentSession` may name a card this extension did not create. Deliberate,
    // resolved decision — board nesting is not ownership, and the board itself
    // lets any session be re-parented (attach_session). Do not add a check.
    spawn: ({ cwd, intent, agent, model, effort, parentSession } = {}) =>
      core.sessionManager.dispatch({ cwd, intent, agent, model, effort, parentSession }),
  },
});

const sessionsKill = ({ id, core }) => ({
  sessions: {
    // reason FORCED, same reasoning as wake: the "killed" line reports confirmed
    // kills and must say who asked for one.
    kill: (sid) => core.sessionManager.killForSession(sid, { reason: `ext:${id}` }),
  },
});

const tasksRead = ({ core }) => ({
  tasks: {
    list: () => core.taskStore.snapshot().tasks.map((t) => projectTask(t, t.id)),
    get: (taskId) => {
      const t = core.taskStore.snapshot().tasks.find((x) => x.id === taskId);
      return t ? projectTask(t, t.id) : null;
    },
    forSession: (sid) => {
      const link = core.taskStore.taskFor(sid);
      return link ? (tasksRead({ core }).tasks.get(link.id)) : null;
    },
  },
});

const tasksWrite = ({ core }) => ({
  tasks: {
    create: (opts) => core.taskStore.createTask(opts),
    rename: (taskId, name) => core.taskStore.renameTask(taskId, name),
    assign: (sid, taskId) => core.taskStore.assign(sid, taskId),
    unassign: (sid) => core.taskStore.unassign(sid),
  },
});

const memoryRead = ({ core }) => ({
  memory: {
    read: (taskId) => core.memoryStore.read(taskId),
    has: (taskId) => core.memoryStore.hasMemory(taskId),
  },
});

const memoryAppend = ({ core }) => ({
  memory: {
    // APPEND only, with no `write` anywhere in the vocabulary: memory.md is a
    // shared human-and-agent file and clobbering it is not an extension's call.
    // Adding a write needs a design discussion, not a follow-up commit.
    append: (taskId, text) => core.memoryStore.append(taskId, text),
  },
});

// The per-extension bound deliver (createExtDeliver, already carrying this
// extension's reason). Narrow two-argument signature — see ext-deliver.js.
const deliverCap = ({ deliver }) => ({ deliver });

const boardRebuild = ({ rebuild }) => ({ rebuild: () => rebuild() });

const boardBroadcast = ({ id, broadcast }) => ({
  // `type` FORCED last so a payload naming 'graph' (or another extension's type)
  // cannot drive a core client path. The client half mirrors this on `send`.
  broadcast: (payload) => broadcast({ ...(payload && typeof payload === 'object' ? payload : {}), type: `ext:${id}` }),
});

const terminalsCreate = ({ createTerminal }) => ({
  terminals: { create: (opts) => createTerminal(opts) },
});

const schedulesRead = ({ scheduleStore }) => ({
  schedules: {
    list: () => scheduleStore.snapshot(),
    get: (sid) => scheduleStore.snapshot().find((s) => s.id === sid) ?? null,
  },
});

const schedulesWrite = ({ scheduleStore }) => ({
  schedules: {
    // Straight through the store, never around it: schedule-store's
    // validateAction is the THIRD model-validation door (the MCP tools and
    // runDispatch are the other two), so constructing rows here would let a
    // schedule be stored against a model no adapter offers and fail at fire time.
    create: (row, now) => scheduleStore.create(row, now),
    update: (sid, patch, now) => scheduleStore.update(sid, patch, now),
    remove: (sid) => scheduleStore.delete(sid),
  },
});

const mailRead = ({ mailStore }) => ({
  mail: {
    unread: (sid) => mailStore.unreadInfo(sid),
    list: (sid) => mailStore.list(sid),
  },
});

const mailSend = ({ id, mailStore }) => ({
  mail: {
    // `from` FORCED: mail is attributable by construction, so an extension can
    // never post a message that reads as having come from a peer session.
    send: (to, text) => mailStore.append(to, { from: `ext:${id}`, body: text }),
  },
});

export const V1_BUILDERS = {
  'sessions:read': sessionsRead,
  'sessions:wake': sessionsWake,
  'sessions:archive': sessionsArchive,
  'sessions:spawn': sessionsSpawn,
  'sessions:kill': sessionsKill,
  'tasks:read': tasksRead,
  'tasks:write': tasksWrite,
  'memory:read': memoryRead,
  'memory:append': memoryAppend,
  deliver: deliverCap,
  'board:rebuild': boardRebuild,
  'board:broadcast': boardBroadcast,
  'terminals:create': terminalsCreate,
  'schedules:read': schedulesRead,
  'schedules:write': schedulesWrite,
  'mail:read': mailRead,
  'mail:send': mailSend,
};
