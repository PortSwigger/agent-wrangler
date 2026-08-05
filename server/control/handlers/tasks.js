import { archiveCascade, descendantsOf } from './archive.js';
import { resumeSession } from './resume.js';

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

// Archive the whole task: stamp it (taskStore.archiveTask), then cascade-archive
// every LIVE session directly assigned to it via the same archiveCascade helper
// "Archive all" uses for a session's descendant tree — same safe kill-jobs-first
// behavior per session, no reinvented teardown. Only DIRECT assignments cascade
// (matches exactly how the live board buckets a task's tile, see app.js's byTask);
// a nested child that isn't itself assigned to this task is unaffected — it just
// stops rendering nested and reappears as its own top-level card.
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
    const { unclean } = await archiveCascade(sessionIds, ctx, { viaTaskArchive: msg.taskId });
    ctx.reply({ type: 'task-archived', taskId: msg.taskId, unclean, archivedSessions: sessionIds.length });
    // Delayed like archive.js's own cascade rebuild: panes just got killed above,
    // so an immediate rebuild risks broadcasting a still-dying tree mid-teardown.
    setTimeout(() => ctx.rebuild().catch(() => {}), 600);
  },
};

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
    // forced restore, or History's "Restore task + sessions" choice) — otherwise
    // this stays the original behavior: the task tile reappears empty, sessions
    // resumed individually from History. Resolved fresh (not from the archive-time
    // count) so a session already resumed individually since the task was archived
    // isn't double-resumed. Sequential, not parallel — mirrors archiveCascade's own
    // one-at-a-time teardown, avoiding a burst of simultaneous tmux launches.
    if (msg.restoreSessions) {
      const cascaded = ctx.sessionManager.archivedEntries()
        .filter((e) => e.viaTaskArchive === msg.taskId)
        .map((e) => e.sessionId);
      for (const sessionId of cascaded) {
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
