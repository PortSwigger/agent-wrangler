export const autoMergeOnPassHandler = {
  type: 'auto-merge-on-pass',
  async handler(msg, ctx) {
    // Per-session opt-in for auto-merging the PR when its checks pass. Pass the
    // cwd/intent through so an externally-discovered session adopts cleanly
    // (like auto-fix-pr-checks / snooze-set).
    const s = ctx.sessionFromGraph(msg.sessionId);
    ctx.sessionManager.setAutoMergeOnPass(msg.sessionId, Boolean(msg.enabled), { cwd: s?.cwd, intent: s?.intent });
    await ctx.rebuild();
  },
};
