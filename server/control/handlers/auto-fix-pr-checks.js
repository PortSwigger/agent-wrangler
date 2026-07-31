export const autoFixPrChecksHandler = {
  type: 'auto-fix-pr-checks',
  async handler(msg, ctx) {
    // Per-session override for the PR check-failure pane nudge. Pass the cwd/intent
    // through so an externally-discovered session adopts cleanly (like snooze-set).
    const s = ctx.sessionFromGraph(msg.sessionId);
    ctx.sessionManager.setAutoFixPrChecks(msg.sessionId, Boolean(msg.enabled), { cwd: s?.cwd, intent: s?.intent });
    await ctx.rebuild();
  },
};
