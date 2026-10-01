import { z } from 'zod';
import { descendantsOf } from '../../control/handlers/archive.js';

// Move a session (default: the caller) onto a task, or back to Ad-hoc — the
// session-to-session counterpart of dragging a card onto a task tile. Mirrors
// the /ws task-assign handler (server/control/handlers/tasks.js): assign, then
// tell the extensions (the `assign` launch-context reason) BEFORE rebuilding, so
// per-task state — task-memory's symlink — follows the new task. Also
// cascades to the target's transitive parentSession family (same as the ws
// handler) so a parent doesn't leave its children assigned to the old task.
export const assignSessionTool = {
  name: 'assign_session',
  description:
    'Assign a session to a task (or back to Ad-hoc/unassigned), the same as dragging its card '
    + 'onto a task tile on the board. `target` defaults to YOU, the caller; pass another session\'s '
    + 'id (from list_sessions) to move it instead. `task_id` is a task id from list_tasks — omit it '
    + '(or pass null) to unassign back to Ad-hoc. Returns the session\'s resulting task.',
  inputSchema: {
    target: z.string().optional().describe('Session id to assign (card id, as returned by list_sessions). Defaults to YOU, the caller.'),
    task_id: z.string().nullable().optional().describe('Task id from list_tasks to assign to. Omit or pass null to unassign back to Ad-hoc.'),
  },
  async handler({ deps, caller }, args = {}) {
    const target = (args.target ?? caller ?? '').trim();
    if (!target) return errorResult('No target session — this request carried no session identity, so pass `target` explicitly.');
    if (!deps.sessionManager.entryFor(target)) {
      return errorResult(`Unknown session ${target} — no such session on the board.`);
    }

    const taskId = args.task_id ? args.task_id.trim() : null;
    if (taskId && !deps.taskStore.assign(target, taskId)) {
      return errorResult(`Unknown task ${taskId} — check list_tasks for valid ids.`);
    }
    if (!taskId) deps.taskStore.assign(target, null);
    await deps.sessionManager.launchContext(target, 'assign');

    // Move the target's whole transitive parentSession family along with it — a
    // child left assigned to the old task would otherwise render as an orphaned
    // top-level card there instead of staying nested (see taskAssignHandler).
    const sessions = deps.graph?.()?.sessions || [];
    for (const child of descendantsOf(target, sessions)) {
      deps.taskStore.assign(child.sessionId, taskId);
      await deps.sessionManager.launchContext(child.sessionId, 'assign');
    }

    await deps.rebuild?.();

    const structuredContent = { target, task: deps.taskStore.taskFor(target) ?? null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
