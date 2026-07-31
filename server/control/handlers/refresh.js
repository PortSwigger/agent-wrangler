export const refreshHandler = {
  type: 'refresh',
  async handler(msg, ctx) {
    await ctx.rebuild();
  },
};
