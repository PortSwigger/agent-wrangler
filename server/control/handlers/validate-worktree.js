import path from 'node:path';
import { expandTilde } from '../../session-manager.js';
import { gitRepoRoot, isLinkedWorktree, worktreeDirName, classifyWorktreeTarget } from '../../worktree.js';

export const validateWorktreeHandler = {
  type: 'validate-worktree',
  async handler(msg, ctx) {
    const cwd = msg.cwd && expandTilde(String(msg.cwd).trim());
    const repoRoot = cwd ? await gitRepoRoot(cwd) : null;
    if (!repoRoot) {
      ctx.reply({ type: 'worktree-validation', ok: false, reason: cwd ? `${cwd} isn't a git repository` : 'No folder selected' });
      return;
    }
    const reply = { type: 'worktree-validation', ok: true, repoName: path.basename(repoRoot), repoRoot, inWorktree: await isLinkedWorktree(cwd) };
    // A branch is supplied only once the user has manually typed one (auto-mode
    // omits it). When present, classify the default target so the client can show
    // the existing-branch / adopt / blocked message live as they type.
    const branch = msg.branch && String(msg.branch).trim();
    if (branch) {
      const folder = path.join(path.dirname(repoRoot), worktreeDirName(repoRoot, branch));
      const cls = await classifyWorktreeTarget({ repoRoot, folder, branch });
      reply.status = cls.status;
      reply.folderPath = folder;
      if (cls.conflictPath) reply.conflictPath = cls.conflictPath;
    }
    ctx.reply(reply);
  },
};
