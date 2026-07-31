import { removeWorktree, deleteBranch, repoRootForWorktree, branchExists } from '../../worktree.js';

// Cleanup offered after archiving a session that ran in a wrangler-created
// worktree. The mapping entry survives archive, so entry.worktree is still
// resolvable here. Both handlers surface a "blocked" reply (dirty worktree /
// unmerged branch) so the client can re-send with force on explicit confirmation.

export const worktreeRemoveHandler = {
  type: 'worktree-remove',
  async handler(msg, ctx) {
    const wt = ctx.sessionManager.entryFor(msg.sessionId)?.worktree;
    if (!wt?.path) {
      ctx.reply({ type: 'error', message: 'No worktree recorded for this session.' });
      return;
    }
    try {
      const repoRoot = await repoRootForWorktree(wt);
      const res = await removeWorktree({ worktreePath: wt.path, repoRoot, force: Boolean(msg.force) });
      if (res.blocked) {
        ctx.reply({ type: 'worktree-remove-blocked', sessionId: msg.sessionId, reason: res.reason });
        return;
      }
      // Re-check the branch so the follow-up toast only offers branch deletion when
      // there's a branch left to delete.
      const stillBranch = Boolean(repoRoot && wt.branch && (await branchExists(repoRoot, wt.branch)));
      ctx.reply({ type: 'worktree-removed', sessionId: msg.sessionId, branch: wt.branch || null, branchExists: stillBranch });
    } catch (e) {
      ctx.reply({ type: 'error', message: e.message });
    }
  },
};

export const branchDeleteHandler = {
  type: 'branch-delete',
  async handler(msg, ctx) {
    const wt = ctx.sessionManager.entryFor(msg.sessionId)?.worktree;
    if (!wt?.branch) {
      ctx.reply({ type: 'error', message: 'No worktree branch recorded for this session.' });
      return;
    }
    try {
      const repoRoot = await repoRootForWorktree(wt);
      if (!repoRoot) {
        ctx.reply({ type: 'error', message: 'Could not resolve the repository for this branch.' });
        return;
      }
      const res = await deleteBranch({ repoRoot, branch: wt.branch, force: Boolean(msg.force) });
      if (res.blocked) {
        ctx.reply({ type: 'branch-delete-blocked', sessionId: msg.sessionId, branch: wt.branch, reason: res.reason });
        return;
      }
      ctx.reply({ type: 'branch-deleted', sessionId: msg.sessionId, branch: wt.branch });
    } catch (e) {
      ctx.reply({ type: 'error', message: e.message });
    }
  },
};
