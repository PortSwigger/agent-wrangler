import path from 'node:path';
import { deepFreeze, projectSession, projectTask, worktreeSummary } from './project.js';
import { cachedScan } from '../usage-scan-memo.js';

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

// Every spawn option is type-checked HERE and refused BY NAME. This is the one
// façade method that starts a process, and dispatch is forgiving by design: a
// mistyped `addDirs` launches with no grants, a `worktree` that is not an object
// launches in the plain cwd, and either reads to the extension author as "the
// option did nothing" with no stack into core to read it from. A refusal is the
// only failure an extension can act on.
const spawnError = (msg) => { throw new TypeError(`sessions.spawn: ${msg}`); };

const WORKTREE_OPTS = ['branch', 'base', 'auto', 'folderName'];

// `{ branch?, base?, auto?, folderName? }` -> dispatch's four flat worktree
// arguments. An UNKNOWN key is refused rather than ignored: `baseRef` for
// `base` ignored is a branch cut from the wrong commit, and nothing downstream
// can tell that from a branch cut from the right one.
function spawnWorktree(worktree) {
  if (worktree === undefined || worktree === null) return {};
  if (typeof worktree !== 'object' || Array.isArray(worktree)) spawnError('worktree must be an object like { branch, base, auto, folderName }');
  const stray = Object.keys(worktree).filter((k) => !WORKTREE_OPTS.includes(k));
  if (stray.length) spawnError(`worktree has unknown option(s) ${stray.join(', ')} (known: ${WORKTREE_OPTS.join(', ')})`);
  for (const k of ['branch', 'base', 'folderName']) {
    if (worktree[k] !== undefined && typeof worktree[k] !== 'string') spawnError(`worktree.${k} must be a string`);
  }
  if (worktree.auto !== undefined && typeof worktree.auto !== 'boolean') spawnError('worktree.auto must be a boolean');
  return {
    worktree: true,
    worktreeBranch: worktree.branch ?? '',
    worktreeBase: worktree.base ?? '',
    worktreeAuto: worktree.auto ?? false,
    worktreeFolderName: worktree.folderName ?? '',
  };
}

// Absolute only, because that is all `--add-dir` means: a relative grant would
// resolve against the wrangler's cwd, never the session's, so it would grant
// something nobody asked for. Existence is dispatch's business (and the
// adapter's), not the façade's.
function checkAddDirs(addDirs) {
  if (addDirs === undefined) return {};
  if (!Array.isArray(addDirs)) spawnError('addDirs must be an array of absolute path strings');
  for (const d of addDirs) {
    if (typeof d !== 'string' || !d || !path.isAbsolute(d)) spawnError(`addDirs entries must be absolute path strings (got ${JSON.stringify(d)})`);
  }
  return { addDirs };
}

const sessionsSpawn = ({ core }) => ({
  sessions: {
    // `parentSession` may name a card this extension did not create. Deliberate,
    // resolved decision — board nesting is not ownership, and the board itself
    // lets any session be re-parented (attach_session). Do not add a check.
    //
    // `spawnedBy` is deliberately NOT passable. It is core's LINEAGE field —
    // "the card whose agent asked for this one" — stamped by the spawn_* tools
    // from the calling session's own id, and an extension is not a session: it
    // has no id of its own to claim there, and any id it named would be another
    // card's. The extension's own attribution already exists on every other
    // outbound value (`ext:<id>` on wake, kill, mail and broadcast).
    spawn: async ({
      cwd, intent, agent, model, effort, autoCompactTokens, parentSession,
      worktree, addDirs, taskId, autoMergeOnPass, autoFixPrChecks,
    } = {}) => {
      const worktreeOpts = spawnWorktree(worktree);
      const addDirsOpt = checkAddDirs(addDirs);
      if (taskId !== undefined && taskId !== null && (typeof taskId !== 'string' || !taskId)) spawnError('taskId must be a non-empty task id');
      for (const [name, v] of [['autoMergeOnPass', autoMergeOnPass], ['autoFixPrChecks', autoFixPrChecks]]) {
        if (v !== undefined && typeof v !== 'boolean') spawnError(`${name} must be a boolean`);
      }
      const result = await core.sessionManager.dispatch({
        cwd,
        intent,
        agent,
        model,
        effort,
        autoCompactTokens,
        parentSession,
        ...worktreeOpts,
        ...addDirsOpt,
        // Dispatch's own default is off, so `false` is simply no override.
        ...(autoMergeOnPass === undefined ? {} : { autoMergeOnPass }),
        // `taskId` is the WHOLE task binding, and it has to be one option
        // rather than a spawn followed by `tasks.assign`: the memory symlink
        // must point at the task BEFORE the pane starts. Claude re-reads
        // AW_TASK_MEMORY and follows a later repoint; Codex resolves the
        // writable root once at launch and never sees it, so an assign after
        // the fact leaves a Codex session writing into its own scratch memory.
        ...(taskId ? { bindMemory: (sid) => core.memoryStore.bindSession(sid, taskId) } : {}),
      });
      // The other half of that binding, exactly as the spawn_* tools and the
      // board's own dispatch do it — a no-op if the task was archived meanwhile,
      // so the session falls back to Ad-hoc rather than failing the launch. It
      // is not a `tasks:write` escalation: the only card it can ever name is the
      // one this call just minted.
      if (taskId) core.taskStore.assign(result.sessionId, taskId);
      // autoFixPrChecks has no dispatch argument — it is a tri-state whose
      // ABSENT value means "on", so an extension driving its own PR automation
      // can only switch core's nudge off through the setter, immediately after
      // launch and long before the agent could open a PR for the poller to find.
      if (autoFixPrChecks !== undefined) core.sessionManager.setAutoFixPrChecks(result.sessionId, autoFixPrChecks);
      // `tmux` stays on the result: it is already in v1 and removing a field is
      // a breaking reshape (that is what v2.js is for), not a tidy-up. The
      // worktree record is READ BACK off the entry rather than returned by
      // dispatch, in the same shape `sessions:read` reports it — without it an
      // extension that asked for a worktree has no way to learn the branch and
      // path the wrangler settled on.
      return { ...result, worktree: deepFreeze(worktreeSummary(core.sessionManager.entryFor(result.sessionId)?.worktree)) };
    },
  },
});

const sessionsKill = ({ id, core }) => ({
  sessions: {
    // reason FORCED, same reasoning as wake: the "killed" line reports confirmed
    // kills and must say who asked for one.
    kill: (sid) => core.sessionManager.killForSession(sid, { reason: `ext:${id}` }),
  },
});

// Stop a card's current turn: Escape into its pane, the key the chat view's Stop
// button sends and both TUIs read as "interrupt". Composed in index.js
// (`interruptSession`) because the pane is tmux-scraper's, which host-api/ does
// not import. Resolves `false` for a card with no live pane (dormant, archived,
// unknown) and never wakes one — there is nothing running to stop. It does NOT
// check the card is working: a second Escape on an idle Claude composer opens
// the rewind menu, so pacing is the caller's, off the graph's `status`.
const sessionsInterrupt = ({ interruptSession }) => ({
  sessions: {
    interrupt: (sid) => interruptSession(sid),
  },
});

// Bill a headless conversation to a card. Thin bind over the primitive, which
// does the validating (a missing card, an empty id or the card's CURRENT
// conversation are all `false`, never a throw) and never touches
// `liveSessionId` — so an extension can make a card PAY for a `claude -p` it
// ran on the card's behalf, but can never make the card RESUME into it.
const sessionsBill = ({ core }) => ({
  sessions: {
    bill: (sid, liveSessionId) => core.sessionManager.recordPriorLiveSessionId(sid, liveSessionId),
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

// cardId -> { cardId, usd, estimatedUsd } over a scanAllDaily result. Two rows can
// share a card (a `/clear` leaves an earlier transcript behind and each is its own
// row, and a billed headless conversation is another), so rows ACCUMULATE onto the
// card rather than replacing each other. `estimatedUsd` is the Codex-estimate
// SLICE of `usd`, a dollar amount and not a flag: any of it means the card's total
// carries an estimate. A row the scanner could not attribute to a card is skipped —
// there is nothing board-shaped to hand it to.
export function usdByCard(scan) {
  const out = new Map();
  for (const row of scan?.sessions || []) {
    if (!row.cardId) continue;
    const cur = out.get(row.cardId) || { cardId: row.cardId, usd: 0, estimatedUsd: 0 };
    for (const bag of Object.values(row.days || {})) {
      cur.usd += bag.usd || 0;
      cur.estimatedUsd += bag.estimatedUsd || 0;
    }
    out.set(row.cardId, cur);
  }
  return [...out.values()];
}

// `scanUsage` is scanAllDaily, wired by index.js (and swapped in tests). It goes
// through the process-wide memo (usage-scan-memo.js), NEVER around it: the scan
// is O(every transcript on disk), the Usage panel already shares that memo, and a
// second consumer keeping a cache of its own would mean two full-history walks
// minutes apart for the same numbers. The result is frozen — it is the memo's
// shared rows summed, and an extension mutating what it was handed must not be
// able to move what the next caller reads.
const usageRead = ({ scanUsage }) => ({
  usage: {
    byCard: async () => deepFreeze(usdByCard(await cachedScan(scanUsage))),
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
  'usage:read': usageRead,
  'sessions:bill': sessionsBill,
  'sessions:interrupt': sessionsInterrupt,
};
