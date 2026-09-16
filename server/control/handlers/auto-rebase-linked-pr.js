export const autoRebaseLinkedPrHandler = {
  type: 'auto-rebase-linked-pr',
  async handler(msg, ctx) {
    const session = ctx.sessionFromGraph(msg.sessionId);
    ctx.sessionManager.setAutoRebaseLinkedPr(msg.sessionId, Boolean(msg.enabled), {
      cwd: session?.cwd,
      intent: session?.intent,
    });
    await ctx.rebuild();
  },
};
