import { z } from 'zod';

// For an autopilot issue→PR run (the `issue-to-pr` skill): rename THIS run's git
// branch to a short, descriptive name once it knows what it's building. The
// dispatch-time branch is just a slug of the raw issue (often the framing, or a
// bare issue number), so this is how a run ends up with a name that says what the
// change does. Keyed on the caller's card id; only works for a session in a
// wrangler-created worktree. Mirrors workflow-phase.js shape.
export const nameBranchTool = {
  name: 'name_branch',
  description:
    'Autopilot only: give THIS run\'s git branch a short, descriptive name now that you know what '
    + 'you\'re building. The dispatch-time branch is a placeholder slug of the raw issue — rename it '
    + 'to 2–4 kebab-case words that say what the change does, e.g. "fix-login-redirect" or '
    + '"add-csv-export". Call it once, early (in the plan phase, before pushing). Only works for a '
    + 'session running in a wrangler-created git worktree. Returns the final branch name '
    + '(auto-suffixed with -2, -3… if that name already existed).',
  inputSchema: {
    name: z.string().min(1).describe(
      'The descriptive branch name: 2–4 kebab-case words describing the work, e.g. '
      + '"improve-worktree-branch-names". Sanitised to a git-ref-safe slug.',
    ),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so the branch cannot be renamed.');
    try {
      const branch = await deps.sessionManager.renameWorktreeBranch(caller, args.name);
      await deps.rebuild?.();
      const structuredContent = { branch };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    } catch (e) {
      return errorResult(e?.message || 'Could not rename the branch.');
    }
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
