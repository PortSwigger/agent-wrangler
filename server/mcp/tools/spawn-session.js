import { z } from 'zod';
import { performSpawn, errorResult } from './spawn-common.js';
import { nestedParentError } from '../../dispatch-runner.js';

// Spin the caller's current work off into a brand-new full board session (not a
// sub-agent, not a fork). Mirrors the /ws `dispatch` handler in server/index.js:
// dispatch → bind memory to the resolved task → assign the fresh card → rebuild.
// The child joins the caller's CURRENT task by default (resolved server-side from
// the card id, reassignment-safe); `into` overrides it; a null caller with no
// `into` lands in Ad-hoc. The shared plumbing lives in performSpawn; this tool
// only supplies the dispatch payload (freeform intent + optional worktree knobs +
// the opt-in `nest` tag).
export const spawnSessionTool = {
  name: 'spawn_session',
  description:
    'Create a brand-new Agent Wrangler session on the board to spin current work off into its '
    + 'own session (not a sub-agent, not a fork). It joins your current task by default; pass '
    + '`into` to put it on a different task. Put the full handoff (what you have done, what the '
    + 'new session should do next, key files/paths) in `intent` — that is its launch prompt. Do '
    + 'NOT write handoff context into task memory: memory is enduring information about the task '
    + 'itself, not a channel for briefing another session. Returns the new session id.',
  inputSchema: {
    intent: z.string().min(1).describe(
      'The new session\'s launch prompt AND the place to hand off context: what has been done, '
      + 'what it should do next, and the key files/paths it needs. This is how you brief it.',
    ),
    cwd: z.string().optional().describe('Working directory to launch in. Defaults to a fresh scratch dir.'),
    model: z.string().optional().describe('Model override for the new session. Defaults to your own model (when launching the same agent).'),
    agent: z.string().optional().describe('Agent to launch (claude or codex). Defaults to claude.'),
    add_dirs: z.array(z.string()).optional().describe('Extra directories to grant the new session (--add-dir).'),
    into: z.string().optional().describe('Task id to put the new session on. Defaults to your current task.'),
    worktree: z.boolean().optional().describe('Launch in a fresh git worktree off cwd.'),
    worktree_branch: z.string().optional().describe('Branch for the worktree (default: derived from intent).'),
    worktree_folder_name: z.string().optional().describe('Folder name/path for the worktree.'),
    worktree_auto: z.boolean().optional().describe('Auto-suffix the branch/folder on collision instead of failing.'),
    nest: z.boolean().optional().describe(
      'Tag the new session as a child of you, nesting it under your card on the board. Default '
      + 'false. This is NOT a judgment call about how related the work is — a spawn that continues '
      + 'your own task, hands off a bug you just found, or is otherwise closely coupled to what '
      + 'you were doing should still default to false. Only pass true when nesting is the '
      + 'deliberate, designed behavior for what you\'re doing (e.g. a workflow orchestrator\'s '
      + 'tracked-worker spawns), or the user explicitly asked for it. If unsure, leave it false.',
    ),
  },
  async handler({ deps, caller }, args = {}) {
    const intent = (args.intent ?? '').trim();
    if (!intent) return errorResult('intent is required.');

    // This tool dispatches via deps.dispatch → sessionManager.dispatch directly
    // (not runDispatch), so it needs its own call to the shared depth guard —
    // see nestedParentError's comment in dispatch-runner.js.
    if (args.nest && caller) {
      const nestErr = nestedParentError(deps.sessionManager, caller);
      if (nestErr) return errorResult(nestErr);
    }

    return performSpawn({
      deps,
      caller,
      args,
      buildDispatch: ({ caller: callerId }) => ({
        // Nesting is opt-in (`nest: true`), not inferred from the caller's own
        // state — a plain "spin off independent work" spawn (or a peer session
        // like an advisor being consulted) should stay a normal top-level
        // session, not get pulled into a visual nesting box by default. Grouping
        // (public/workflow.js `isWorkflowWorker`) walks parentSession
        // transitively and only wraps it in the violet workflow box when the
        // parent is itself an orchestrator; otherwise it renders as a plain
        // nested child. This never sets `workflow` — that field is
        // orchestrator-only.
        intent,
        worktree: Boolean(args.worktree),
        worktreeBranch: args.worktree_branch || '',
        worktreeFolderName: args.worktree_folder_name || '',
        worktreeAuto: Boolean(args.worktree_auto),
        parentSession: (args.nest && callerId) || undefined,
      }),
    });
  },
};
