import { mostCommonCwd } from '../../../public/util.js';

// Read-only board snapshot of the tasks (columns) and their ids — the supported
// way to discover the `into` target for spawn_session without reading the raw
// tasks.json state file. `bestFolder` (the natural cwd to launch a new session
// for a task) reuses the exact heuristic the board UI shows: `mostCommonCwd`
// (public/util.js) folds each session's cwd to its repo root — collapsing both
// wrangler `<repo>-worktree-<branch>` siblings and `.claude/worktrees/` dirs —
// excludes throwaway scratch dirs, and picks the most frequent repo (ties → most
// recently active). Keeping one implementation means the tool and the card can
// never disagree about where a task lives.
export const listTasksTool = {
  name: 'list_tasks',
  description:
    'List the Agent Wrangler tasks (board columns) and their ids — the supported way to '
    + 'discover the `into` target for spawn_session/spawn_workflow. Each task carries its id, '
    + 'name, the number of sessions assigned to it (`sessionCount`, counting dormant/suspended '
    + 'sessions too, not just live ones), and `bestFolder`: the natural directory to launch a new session '
    + 'in (the repo the task\'s existing sessions mostly run in, with transient git worktrees '
    + 'folded back to their base repo and scratch dirs ignored). `bestFolder` is null for a task '
    + 'with no settled folder yet — fall back to the spawn default. Unassigned (ad-hoc) sessions '
    + 'belong to no task and are excluded. Read-only.',
  inputSchema: {},
  async handler({ deps }) {
    // Archived tasks are off the board (see taskStore.archiveTask) — exclude them
    // so an agent can never spawn/assign into one via the `into`/task_id contract;
    // assign_session's taskStore.assign() also refuses them as a second layer.
    const tasks = (deps.taskStore.snapshot().tasks ?? []).filter((t) => !t.archivedAt);
    const sessionsByTask = new Map(tasks.map((t) => [t.id, []]));
    for (const s of deps.graph()?.sessions ?? []) {
      const bucket = sessionsByTask.get(deps.taskStore.taskFor(s.sessionId)?.id);
      if (bucket) bucket.push(s);
    }
    const out = tasks.map((t) => {
      const sess = sessionsByTask.get(t.id);
      return {
        id: t.id,
        name: t.name,
        sessionCount: sess.length,
        bestFolder: mostCommonCwd(sess, deps.sessionsDir) || null,
      };
    });
    const structuredContent = { tasks: out };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};
