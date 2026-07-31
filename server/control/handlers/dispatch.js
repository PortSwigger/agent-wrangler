import { runDispatch } from '../../dispatch-runner.js';

export const dispatchHandler = {
  type: 'dispatch',
  async handler(msg, ctx) {
    try {
      // All the launch logic (autopilot wrap, force-auto-worktree, memory bind, task
      // assign) lives in the shared runDispatch so a scheduled dispatch fires the
      // exact same path — no drift. This handler only owns the rebuild + ack.
      const { sessionId } = await runDispatch(msg, ctx);
      await ctx.rebuild();
      // Positive ack so the dialog can close only after the worktree exists.
      ctx.reply({ type: 'dispatched', sessionId });
    } catch (e) {
      ctx.reply({ type: 'error', message: e?.message || 'Dispatch failed' });
    }
  },
};
