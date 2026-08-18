export const childFullViewHandler = {
  type: 'set-child-full-view',
  async handler(msg, ctx) {
    // Per-CHILD override for whether it renders full or compact — pass the
    // cwd/intent through so an externally-discovered session adopts cleanly
    // (like auto-fix-pr-checks/snooze-set).
    const s = ctx.sessionFromGraph(msg.sessionId);
    ctx.sessionManager.setChildFullView(msg.sessionId, Boolean(msg.enabled), { cwd: s?.cwd, intent: s?.intent });
    await ctx.rebuild();
  },
};
