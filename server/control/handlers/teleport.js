// Teleport a cloud card into a local worktree. Thin on purpose (like resume.js):
// the launch, the detached-worktree creation and the post-launch branch/live-id
// reconcile all live in SessionManager.teleport, so this handler only owns the
// error relay, the rebuild and the ack.
//
// One-way and deliberately not offered in reverse: there is no "send it back to
// the cloud" — the local worktree is now the source of truth, and re-uploading it
// isn't something the CLI can do.
export const teleportHandler = {
  type: 'teleport',
  async handler(msg, ctx) {
    try {
      const result = await ctx.sessionManager.teleport(msg.sessionId);
      // The card keeps its id through the conversion, so the client needs no
      // re-selection — but it does need the rebuild to see the card as local
      // (transcript, cost, diff, terminal and mail all light up on that graph).
      await ctx.rebuild();
      ctx.reply({ type: 'teleported', sessionId: result.sessionId, cwd: result.cwd, branch: result.branch });
    } catch (e) {
      ctx.reply({ type: 'error', message: e?.message || 'Teleport failed' });
    }
  },
};
