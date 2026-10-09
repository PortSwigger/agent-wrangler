import { log } from '../../log.js';

// The board's "Restart tmux" button on the old-login-session banner (see
// gui-session.js). Stopping the tmux server stops every running agent, so it is
// refused unless the startup check found the problem and it still holds: a stale
// tab must not be able to take every session down on a healthy install. The check
// runs again afterwards, so the banner clears from the real state (no server is
// running, which is not a problem) rather than from an assumption.
export const restartTmuxHandler = {
  type: 'restart-tmux',
  async handler(msg, ctx) {
    if (!ctx.staleGuiSession()) {
      throw new Error('The tmux server is not in an old login session, so there is nothing to restart.');
    }
    log('[gui-session] restarting the tmux server from the board; running sessions go dormant');
    await ctx.sessionManager.killTmuxServer();
    await ctx.recheckGuiSession();
    await ctx.rebuild();
    ctx.reply({ type: 'restart-tmux-done' });
  },
};
