// What an extension sees of a session or a task: an explicit, frozen allow-list
// COPY, never the live mapping entry. Two independent reasons, and both have to
// hold — a deny-list would silently start leaking whatever field lands next.
//
// 1. `liveSessionId` and `priorLiveSessionIds` are DELIBERATELY absent, and this
//    is the single most likely thing a future contributor adds back "for
//    completeness". A live id is a conversation id, and a conversation id is
//    `--resume`-able: handing one to an extension lets it reach a conversation
//    outside the board's own lifecycle (and outside resolveResumeDir's guard,
//    which is what stops a resume silently starting a blank session). The card
//    id is the only handle an extension ever needs — every host method takes it.
// 2. Nothing is included merely so it can be written back. A mutation belongs
//    behind a declared capability method, not behind a read plus a store poke,
//    which is exactly what a fuller projection would invite.
//
// Frozen DEEPLY as well as copied: a contribution that mutates what it was
// handed must be inert, not just refused at the top level — otherwise a nested
// worktree object would still be a live shared reference in every reader.

export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj)) deepFreeze(v);
  return obj;
}

// The worktree SUMMARY, not the stored object: `repoRoot` is how the branch is
// found after the dir is deleted, `branch`/`path` are what a reader wants to
// name it. Everything else on there is lifecycle bookkeeping the core owns.
// Exported because `sessions:spawn` returns the same shape for a worktree it
// just cut — one definition, so what a spawn hands back and what a later
// `sessions.get()` reports cannot drift.
export function worktreeSummary(wt) {
  if (!wt || typeof wt !== 'object') return null;
  return { branch: wt.branch ?? null, path: wt.path ?? null, repoRoot: wt.repoRoot ?? null };
}

// `taskId` is passed in rather than read off the entry: the session→task link
// lives in task-store, not in the mapping, and this stays a pure projection.
export function projectSession(entry, id, { taskId = null } = {}) {
  const e = entry || {};
  return deepFreeze({
    sessionId: id ?? null,
    agent: e.agent ?? 'claude',
    cwd: e.cwd ?? null,
    intent: e.intent ?? '',
    model: e.model ?? null,
    effort: e.effort ?? null,
    runtime: e.runtime ?? 'local',
    name: e.name ?? '',
    lastLabel: e.lastLabel ?? '',
    taskId,
    archived: Boolean(e.archivedAt),
    archivedAt: e.archivedAt ?? null,
    snoozedUntil: e.snooze?.until ?? null,
    suspendPending: Boolean(e.suspendPending),
    workflow: e.workflow ?? null,
    createdAt: e.createdAt ?? null,
    lastActivity: e.lastActivity ?? null,
    parentSession: e.parentSession ?? null,
    spawnedBy: e.spawnedBy ?? null,
    worktree: worktreeSummary(e.worktree),
  });
}

// Same allow-list shape for a task. `todos` and `links` are omitted: both are
// lists an extension would only want in order to write them back, and neither
// has a capability method behind it.
export function projectTask(task, id) {
  const t = task || {};
  return deepFreeze({
    taskId: id ?? t.id ?? null,
    name: t.name ?? '',
    archived: Boolean(t.archivedAt),
    archivedAt: t.archivedAt ?? null,
    createdAt: t.createdAt ?? null,
  });
}
