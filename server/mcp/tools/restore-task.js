import { z } from 'zod';
import { cascadedSessionIds } from '../../control/handlers/tasks.js';
import { resumeSession } from '../../control/handlers/resume.js';

export const restoreTaskTool = {
  name: 'restore_task',
  description:
    'Restore an archived task onto the board — the same as the board\'s Search "Restore task". By default '
    + 'it also resumes the sessions that were archived along with it (restore_sessions: false brings back '
    + 'just the empty tile). Use this before restore_session when a session belongs to an archived task. '
    + 'Get archived task ids from list_tasks with archived: true. A session whose launch directory is gone is reported in failed_sessions; restore it with restore_session and recreate_dir: true.',
  inputSchema: {
    task_id: z.string().min(1).describe('Archived task id to restore.'),
    restore_sessions: z.boolean().optional().describe('Also resume sessions archived with the task. Default true.'),
  },
  async handler({ deps }, args = {}) {
    const taskId = (args.task_id ?? '').trim();
    if (!taskId) return errorResult('task_id is required.');
    const task = deps.taskStore.tasks.find((t) => t.id === taskId);
    if (!task) return errorResult(`Unknown task ${taskId}.`);
    if (!task.archivedAt) return errorResult(`Task ${taskId} is not archived.`);
    deps.taskStore.unarchiveTask(taskId);
    await deps.rebuild?.();
    const replies = [];
    const ctx = { ...deps, reply: (m) => replies.push(m) };
    const restored = [];
    const failed = [];
    if (args.restore_sessions !== false) {
      for (const sessionId of cascadedSessionIds(taskId, deps.sessionManager)) {
        try {
          replies.length = 0;
          await resumeSession(sessionId, ctx);
          const needsDir = replies.find((m) => m.type === 'resume-needs-dir');
          if (needsDir) {
            failed.push({
              session_id: sessionId,
              error: `Launch directory ${needsDir.dir} no longer exists — call restore_session with recreate_dir: true.`,
            });
          } else {
            restored.push(sessionId);
          }
        } catch (err) {
          failed.push({ session_id: sessionId, error: err?.message || String(err) });
        }
      }
    }
    const structuredContent = { task_id: taskId, restored: true, restored_sessions: restored, failed_sessions: failed };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
