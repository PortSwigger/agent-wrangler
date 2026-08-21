import { z } from 'zod';
import { performSpawn, errorResult } from './spawn-common.js';
import { workflowLaunchPrompt } from '../../workflow.js';
import { slugFromIntent } from '../../worktree.js';

// Kick off a brand-new TOP-LEVEL autopilot issue→PR run (an orchestrator), as
// opposed to spawn_session which hands current work off to a peer. Mirrors the
// workflow branch of the /ws `dispatch` handler (server/control/handlers/
// dispatch.js): wrap the raw issue into a skill-naming launch prompt, force a
// fresh auto worktree on (a fleet of runs must never share a checkout), seed the
// branch from the raw issue (the wrapped prompt would otherwise slug to
// "use-issue-to-pr-skill"), and stamp the orchestrator `workflow` marker that
// loads the issue-to-pr skill and drives the board chip.
//
// CRITICAL: this always mints a FRESH orchestrator marker — never a `{ parent }`
// worker tag — even when the caller is itself an orchestrator. A workflow spawned
// by another session is its own run, not that session's worker, so it must run
// the procedure and report its own phases (unlike spawn_session's workers).
export const spawnWorkflowTool = {
  name: 'spawn_workflow',
  description:
    'Start a brand-new autonomous issue→PR run on the board (an Agent Wrangler "workflow"): a '
    + 'top-level session that takes an issue all the way to a pull request on its own, via the '
    + 'issue-to-pr skill, in its own fresh git worktree. Use this to kick off autopilot on an '
    + 'issue — NOT to hand off your current work (that is spawn_session). Pass the issue (a Jira '
    + 'key, a GitHub issue URL/number, or a free-text description) in `issue`. The run is always '
    + 'top-level even when you start it from another session. Returns the new session id and its '
    + 'label — when telling the user about it, use the label, not the id, which means nothing to '
    + 'them.',
  inputSchema: {
    issue: z.string().min(1).describe(
      'The issue to take to a PR: a Jira key (ENT-1234), a GitHub issue URL/number, or a free-text '
      + 'description of the work. It is wrapped into the issue-to-pr skill launch prompt.',
    ),
    cwd: z.string().optional().describe('Working directory to launch in (the repo the worktree branches off). Defaults to a fresh scratch dir.'),
    model: z.string().optional().describe('Model override for the run. Defaults to your own model (when launching the same agent).'),
    agent: z.string().optional().describe('Agent to launch (claude or codex). Defaults to claude.'),
    add_dirs: z.array(z.string()).optional().describe('Extra directories to grant the run (--add-dir).'),
    into: z.string().optional().describe(
      'Task id to put the run on, sourced from list_tasks. An id not sourced from list_tasks '
      + 'silently lands the run in Unassigned instead of erroring. Defaults to your current '
      + 'task; omit to keep it there.',
    ),
  },
  async handler({ deps, caller }, args = {}) {
    const rawIssue = (args.issue ?? '').trim();
    if (!rawIssue) return errorResult('issue is required.');

    const now = Date.now();
    return performSpawn({
      deps,
      caller,
      args,
      // The orchestrator marker is fixed regardless of the caller — no worker
      // tagging — and the worktree is forced on with an auto-suffixed branch
      // seeded from the raw issue, exactly as the /ws workflow dispatch does.
      buildDispatch: () => ({
        intent: workflowLaunchPrompt(rawIssue),
        worktree: true,
        worktreeBranch: slugFromIntent(rawIssue),
        worktreeFolderName: '',
        worktreeAuto: true,
        workflow: { issue: rawIssue, phase: { label: 'starting', kind: 'active', at: now }, startedAt: now },
      }),
    });
  },
};
