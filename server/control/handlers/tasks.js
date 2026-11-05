import { archiveCascade, descendantsOf } from './archive.js';
import { resumeSession } from './resume.js';
import { detachError } from './detach.js';
import { attachError } from './attach.js';
import { ADHOC } from '../../task-store.js';

const draftTasks = new WeakMap();
function draftsFor(store) {
  if (!draftTasks.has(store)) draftTasks.set(store, new Map());
  return draftTasks.get(store);
}

export const taskCreateHandler = {
  type: 'task-create',
  async handler(msg, ctx) {
    const sessions = ctx.graph?.()?.sessions || [];
    const parentSession = msg.draft && msg.sessionId
      ? ctx.sessionManager.entryFor(msg.sessionId)?.parentSession : null;
    if (parentSession) {
      const error = detachError(msg.sessionId, ctx.sessionManager);
      if (error) throw new Error(error);
    }
    const snapshot = msg.draft ? ctx.taskStore.snapshot() : null;
    const task = ctx.taskStore.createTask({ name: msg.name, sessionId: msg.sessionId });
    // Dragging a parent-with-children onto "+ New task" seeds the task with just
    // the parent (createTask's own contract); bring its family along too, or a
    // child is left behind on the old task/Ad-hoc — same fix as taskAssignHandler.
    if (msg.sessionId) {
      for (const child of descendantsOf(msg.sessionId, sessions)) ctx.taskStore.assign(child.sessionId, task.id);
    }
    if (msg.draft) {
      draftsFor(ctx.taskStore).set(task.id, {
        snapshot, sessionId: msg.sessionId, parentSession,
        sessionIds: msg.sessionId ? [msg.sessionId, ...descendantsOf(msg.sessionId, sessions).map((s) => s.sessionId)] : [],
      });
      if (parentSession) ctx.sessionManager.detachSession(msg.sessionId);
    }
    ctx.reply({ type: 'task-created', taskId: task.id });
    await ctx.rebuild();
  },
};

export const taskRenameHandler = {
  type: 'task-rename',
  async handler(msg, ctx) {
    ctx.taskStore.renameTask(msg.taskId, msg.name);
    draftsFor(ctx.taskStore).delete(msg.taskId);
    await ctx.rebuild();
  },
};

// Archive the whole task: stamp it (taskStore.archiveTask), then cascade-archive
// every LIVE session directly assigned to it via the same archiveCascade helper
// "Archive all" uses for a session's descendant tree — same safe kill-jobs-first
// behavior per session, no reinvented teardown. Only DIRECT assignments cascade
// (matches exactly how the live board buckets a task's tile, see app.js's byTask);
// a nested child that isn't itself assigned to this task is unaffected — it just
// stops rendering nested and reappears as its own top-level card.
// Shared with the `tasks:archive` host capability (server/index.js). Returns null
// when there was nothing to archive (unknown or already archived).
export async function archiveTaskCascade(taskId, ctx) {
  if (!ctx.taskStore.archiveTask(taskId)) return null;
  const { assignments } = ctx.taskStore.snapshot();
  const sessionIds = Object.entries(assignments)
    .filter(([, tid]) => tid === taskId)
    .map(([sid]) => sid)
    .filter((sid) => !ctx.sessionManager.isArchived(sid));
  const { unclean } = await archiveCascade(sessionIds, ctx, { viaTaskArchive: taskId });
  return { sessionIds, unclean };
}

export const taskArchiveHandler = {
  type: 'task-archive',
  async handler(msg, ctx) {
    const result = await archiveTaskCascade(msg.taskId, ctx);
    if (!result) {
      await ctx.rebuild();
      return;
    }
    const { sessionIds, unclean } = result;
    ctx.reply({ type: 'task-archived', taskId: msg.taskId, unclean, archivedSessions: sessionIds.length });
    // Delayed like archive.js's own cascade rebuild: panes just got killed above,
    // so an immediate rebuild risks broadcasting a still-dying tree mid-teardown.
    setTimeout(() => ctx.rebuild().catch(() => {}), 600);
  },
};

export function cascadedSessionIds(taskId, sessionManager) {
  return sessionManager.archivedEntries()
    .filter((e) => e.viaTaskArchive === taskId)
    .map((e) => e.sessionId);
}

export const taskUnarchiveHandler = {
  type: 'task-unarchive',
  async handler(msg, ctx) {
    if (!ctx.taskStore.unarchiveTask(msg.taskId)) {
      await ctx.rebuild();
      return;
    }
    await ctx.rebuild();
    // Sent right away, decoupled from the (potentially slow) per-session resumes
    // below, so the client can navigate back to the board / halo the tile without
    // waiting on N tmux relaunches. See resumeSession's own rebuild for the
    // eventual per-session board update.
    ctx.reply({ type: 'task-unarchived', taskId: msg.taskId });
    // Only when the client explicitly asked to restore sessions too (the toast's
    // forced restore, or Search's "Restore task + sessions" choice) — otherwise
    // this stays the original behavior: the task tile reappears empty, sessions
    // resumed individually from Search. Resolved fresh (not from the archive-time
    // count) so a session already resumed individually since the task was archived
    // isn't double-resumed. Sequential, not parallel — mirrors archiveCascade's own
    // one-at-a-time teardown, avoiding a burst of simultaneous tmux launches.
    if (msg.restoreSessions) {
      for (const sessionId of cascadedSessionIds(msg.taskId, ctx.sessionManager)) {
        await resumeSession(sessionId, ctx);
      }
    }
  },
};

export const taskAssignHandler = {
  type: 'task-assign',
  async handler(msg, ctx) {
    const taskId = msg.taskId || null;
    // A parent's children are bucketed by their OWN assignment (assignedTaskId in
    // app.js) — assigning only the dragged session leaves its family behind on the
    // old task, rendering as orphaned top-level cards there. Move the whole
    // transitive `parentSession` family in one go, same set archiveCascade/
    // promoteSession treat as a unit, so nesting survives the move. One rebuild
    // for the whole family, not one per session, so clients never see it split
    // across two tiles mid-move.
    const sessions = ctx.graph?.()?.sessions || [];
    const ids = [msg.sessionId, ...descendantsOf(msg.sessionId, sessions).map((d) => d.sessionId)];
    for (const id of ids) {
      ctx.taskStore.assign(id, taskId);
      // Not a launch: the `assign` reason lets the extensions re-point per-task
      // state (task-memory's symlink), and what they granted is what a live
      // devcontainer session needs re-copied.
      const { addDirs } = await ctx.sessionManager.launchContext(id, 'assign');
      await ctx.sessionManager.syncNotesToContainer(id, { addDirs }).catch(() => {});
    }
    await ctx.rebuild();
  },
};

export const taskReorderHandler = {
  type: 'task-reorder',
  async handler(msg, ctx) {
    ctx.taskStore.reorderTask(msg.taskId, msg.targetId || null, { move: msg.mode === 'move', after: msg.after === true });
    await ctx.rebuild();
  },
};

export const taskReorderSessionsHandler = {
  type: 'task-reorder-sessions',
  async handler(msg, ctx) {
    ctx.taskStore.reorderSession(msg.taskId, Array.isArray(msg.order) ? msg.order : []);
    await ctx.rebuild();
  },
};

// Permanently delete a task. Core removes it first (taskStore.deleteTask also
// unassigns its sessions), then every enabled extension that declares
// `onTaskDelete` is told — after the fact, errors isolated per extension (see
// createTaskDeleteNotifier) — so data keyed by the task id can be dropped.
export const taskDeleteHandler = {
  type: 'task-delete',
  async handler(msg, ctx) {
    const drafts = draftsFor(ctx.taskStore);
    if (msg.undoCreate) {
      const draft = drafts.get(msg.taskId);
      if (!draft) throw new Error('This task can no longer be cancelled.');
      const current = ctx.taskStore.snapshot();
      const restored = draft.sessionIds.filter((sid) => current.assignments[sid] === msg.taskId);
      const buckets = new Set();
      for (const sid of restored) {
        const original = draft.snapshot.assignments[sid] || null;
        ctx.taskStore.assign(sid, original);
        buckets.add(original || ADHOC);
      }
      const updated = ctx.taskStore.snapshot();
      for (const bucket of buckets) {
        if (!draft.snapshot.sessionOrder[bucket] && !updated.sessionOrder[bucket]) continue;
        ctx.taskStore.reorderSession(bucket, [
          ...(draft.snapshot.sessionOrder[bucket] || []), ...(updated.sessionOrder[bucket] || []),
        ]);
      }
      if (draft.parentSession && restored.includes(draft.sessionId)
          && !ctx.sessionManager.entryFor(draft.sessionId)?.parentSession
          && !attachError(draft.sessionId, draft.parentSession, { sessions: ctx.graph?.()?.sessions || [], taskStore: ctx.taskStore })) {
        ctx.sessionManager.attachSession(draft.sessionId, draft.parentSession);
      }
    }
    drafts.delete(msg.taskId);
    const unassigned = ctx.taskStore.deleteTask(msg.taskId);
    if (!unassigned) {
      await ctx.rebuild();
      return;
    }
    await ctx.ext?.fireTaskDelete?.(msg.taskId);
    await ctx.rebuild();
  },
};
