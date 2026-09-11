export const removeHandler = {
  type: 'remove',
  async handler(msg, ctx) {
    // Permanently forget an archived session — irrecoverable.
    try {
      await ctx.sessionManager.killForSession(msg.sessionId, { reason: 'purge' });
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
    // An extension's per-session state (the checklist) follows the same rule and
    // is dropped by its `session.onPurge` hook, fired from sessionManager.forget()
    // above — never from here directly.
    setTimeout(() => ctx.rebuild().catch(() => {}), 200);
  },
};
