export const removeHandler = {
  type: 'remove',
  async handler(msg, ctx) {
    // Permanently forget an archived session — irrecoverable.
    try {
      await ctx.sessionManager.killForSession(msg.sessionId);
    } catch {
      /* already gone */
    }
    ctx.sessionManager.forget(msg.sessionId);
    ctx.taskStore.unassign(msg.sessionId);
    ctx.memoryStore.forget(msg.sessionId);
    // The mailbox is retained through archive but this is the actual "card
    // purged from mappings.json" moment the spec ties mail deletion to — never
    // on archive, only here.
    ctx.mailStore.forget(msg.sessionId);
    setTimeout(() => ctx.rebuild().catch(() => {}), 200);
  },
};
