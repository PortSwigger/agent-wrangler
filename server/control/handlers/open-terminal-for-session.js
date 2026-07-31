import crypto from 'node:crypto';

// Human-triggered: the user clicks "Open terminal" on a live session's header.
// Creates a plain-shell tmux in that session's cwd, registers it in the terminal
// registry, and broadcasts `open-terminal` so all board clients open the pane.
export const openTerminalForSessionHandler = {
  type: 'open-terminal-for-session',
  async handler(msg, ctx) {
    const entry = ctx.sessionManager.entryFor(msg.sessionId);
    if (!entry?.cwd) {
      ctx.reply({ type: 'error', message: 'Session has no working directory.' });
      return;
    }
    const terminalId = `t_${crypto.randomBytes(4).toString('hex')}`;
    let tmuxName;
    try {
      tmuxName = await ctx.createShellSession(entry.cwd, ctx.sessionManager.socket, '');
    } catch (err) {
      ctx.reply({ type: 'error', message: `Failed to create shell session: ${String(err.message || err)}` });
      return;
    }
    ctx.terminalRegistry.set(terminalId, { tmuxName, socket: ctx.sessionManager.socket, cwd: entry.cwd });
    ctx.broadcast({ type: 'open-terminal', terminalId, command: '', sessionId: msg.sessionId });
  },
};
