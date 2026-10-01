export const getMemoryHandler = {
  type: 'get-memory',
  async handler(msg, ctx) {
    ctx.reply({ type: 'memory', taskId: msg.taskId, md: ctx.memoryStore.read(msg.taskId) });
  },
};

export const setMemoryHandler = {
  type: 'set-memory',
  async handler(msg, ctx) {
    // The memory watcher picks up this write and fans out memory-changed + a rebuild
    // (dot refresh) on its own — same path as an agent's append — so there's
    // nothing to broadcast here.
    ctx.memoryStore.write(msg.taskId, msg.md ?? '');
  },
};
