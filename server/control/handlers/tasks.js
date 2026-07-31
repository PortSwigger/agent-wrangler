export const taskCreateHandler = {
  type: 'task-create',
  async handler(msg, ctx) {
    ctx.taskStore.createTask({ name: msg.name, sessionId: msg.sessionId });
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

export const taskAssignHandler = {
  type: 'task-assign',
  async handler(msg, ctx) {
    ctx.taskStore.assign(msg.sessionId, msg.taskId || null);
    ctx.memoryStore.bindSession(msg.sessionId, msg.taskId || null);
    await ctx.sessionManager.syncNotesToContainer(msg.sessionId).catch(() => {});
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
