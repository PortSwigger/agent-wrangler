import { z } from 'zod';

// Rename THIS session's git branch once it knows what it's building: the
// dispatch-time branch is a placeholder (a slug of the raw issue for an autopilot
// issue→PR run, a machine id for an automated job's sub-job), so this is how a
// branch ends up with a name that says what the change does. Keyed on the
// caller's card id; only works for a session in a wrangler-created worktree.
// A job session (`automationRun`) is told to follow its repository's own
// convention, so its name is kept VERBATIM (case, slashes, a Jira key) and only
// checked as a git ref, where an autopilot run's is slugged; and the job store
// is told, because the sub-job's worktree record is a copy that the PR observer
// and cleanup match on. Mirrors workflow-phase.js shape.
export const nameBranchTool = {
  name: 'name_branch',
  description:
    'Give THIS session\'s git branch its real name now that you know what you\'re building; the '
    + 'dispatch-time branch is a placeholder. For an automated job sub-job, use the repository\'s own '
    + 'branch-naming convention exactly (e.g. "AUTH-123-short-description" or "fix/AUTH-123-short-description"), '
    + 'as your instructions describe; the name is used verbatim. For an autopilot issue→PR run, use 2–4 '
    + 'kebab-case words that say what the change does, e.g. "fix-login-redirect". Call it once, early, '
    + 'before pushing. Only works for a session running in a wrangler-created git worktree. Returns the '
    + 'final branch name (auto-suffixed with -2, -3… if that name already existed).',
  inputSchema: {
    name: z.string().min(1).describe(
      'The branch name. A job sub-job\'s is used verbatim and must be a valid git branch name; an '
      + 'autopilot run\'s is sanitised to a kebab-case slug.',
    ),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so the branch cannot be renamed.');
    try {
      const automated = Boolean(deps.sessionManager.entryFor?.(caller)?.automationRun);
      const branch = await deps.sessionManager.renameWorktreeBranch(caller, args.name, { verbatim: automated });
      if (automated) deps.jobStore?.noteBranchRename(caller, branch);
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
