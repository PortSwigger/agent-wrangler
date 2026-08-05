import { archiveCascade, descendantsOf } from './archive.js';

export const taskCreateHandler = {
  type: 'task-create',
  async handler(msg, ctx) {
    const task = ctx.taskStore.createTask({ name: msg.name, sessionId: msg.sessionId });
    // Dragging a parent-with-children onto "+ New task" seeds the task with just
    // the parent (createTask's own contract); bring its family along too, or a
    // child is left behind on the old task/Ad-hoc — same fix as taskAssignHandler.
    if (msg.sessionId) {
      const sessions = ctx.graph?.()?.sessions || [];
      for (const child of descendantsOf(msg.sessionId, sessions)) ctx.taskStore.assign(child.sessionId, task.id);
    }
    await ctx.rebuild();
  },
};

export const taskRenameHandler = {
  type: 'task-rename',
  async handler(msg, ctx) {
    ctx.taskStore.renameTask(msg.taskId, msg.name);
    await ctx.rebuild();
  },
};

export const taskDeleteHandler = {
  type: 'task-delete',
  async handler(msg, ctx) {
    const snap = ctx.taskStore.deleteTask(msg.taskId);
    if (snap) {
      ctx.pendingTaskRestores.set(msg.taskId, snap);
      // Freed sessions fall back to Ad-hoc → point their memory at scratch.
      for (const sid of Object.keys(snap.assignments)) ctx.memoryStore.bindSession(sid, null);
    }
    await ctx.rebuild();
  },
};

export const taskRestoreHandler = {
  type: 'task-restore',
  async handler(msg, ctx) {
    const snap = ctx.pendingTaskRestores.get(msg.taskId);
    if (snap && ctx.taskStore.restoreTask(snap)) {
      ctx.pendingTaskRestores.delete(msg.taskId);
      // Restore each session's memory link back to the recovered task file.
      for (const [sid, tid] of Object.entries(snap.assignments)) ctx.memoryStore.bindSession(sid, tid);
    }
    await ctx.rebuild();
  },
};

// Archive the whole task: stamp it (taskStore.archiveTask), then cascade-archive
// every LIVE session directly assigned to it via the same archiveCascade helper
// "Archive all" uses for a session's descendant tree — same safe kill-jobs-first
// behavior per session, no reinvented teardown. Only DIRECT assignments cascade
// (matches exactly how the live board buckets a task's tile, see app.js's byTask);
// a nested child that isn't itself assigned to this task is unaffected — it just
// stops rendering nested and reappears as its own top-level card, the same
// non-cascading treatment deleteTask already gives an unassigned child.
export const taskArchiveHandler = {
  type: 'task-archive',
  async handler(msg, ctx) {
    if (!ctx.taskStore.archiveTask(msg.taskId)) {
      await ctx.rebuild();
      return;
    }
    const { assignments } = ctx.taskStore.snapshot();
    const sessionIds = Object.entries(assignments)
      .filter(([, tid]) => tid === msg.taskId)
      .map(([sid]) => sid)
      .filter((sid) => !ctx.sessionManager.isArchived(sid));
    const { unclean } = await archiveCascade(sessionIds, ctx);
    ctx.reply({ type: 'task-archived', taskId: msg.taskId, unclean, archivedSessions: sessionIds.length });
    // Delayed like archive.js's own cascade rebuild: panes just got killed above,
    // so an immediate rebuild risks broadcasting a still-dying tree mid-teardown.
    setTimeout(() => ctx.rebuild().catch(() => {}), 600);
  },
};

export const taskUnarchiveHandler = {
  type: 'task-unarchive',
  async handler(msg, ctx) {
    // Deliberately does not resume any session the task-archive cascaded — that
    // would auto-relaunch N tmux processes as a side effect of restoring a data
    // record. The task tile just reappears (empty until sessions are
    // individually resumed from History, same as they always were).
    ctx.taskStore.unarchiveTask(msg.taskId);
    await ctx.rebuild();
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
      ctx.memoryStore.bindSession(id, taskId);
      await ctx.sessionManager.syncNotesToContainer(id).catch(() => {});
    }
    await ctx.rebuild();
  },
};

export const taskReorderHandler = {
  type: 'task-reorder',
  async handler(msg, ctx) {
    ctx.taskStore.reorderTask(msg.taskId, msg.targetId || null);
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
