export const renameHandler = {
  type: 'rename',
  async handler(msg, ctx) {
    const s = ctx.sessionFromGraph(msg.sessionId);
    ctx.sessionManager.rename(msg.sessionId, msg.name, { cwd: s?.cwd, intent: s?.intent });
    await ctx.rebuild();
  },
};
