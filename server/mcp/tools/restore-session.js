import { z } from 'zod';
import { resumeSession } from '../../control/handlers/resume.js';

export const restoreSessionTool = {
  name: 'restore_session',
  description:
    'Restore an archived or dormant Agent Wrangler session onto the board — the same as the board\'s '
    + 'Search "Restore"/Resume. If its task is still archived it falls back to Ad-hoc; use restore_task '
    + 'to bring the task back first. Refuses a session that is already live. If its working directory '
    + 'was deleted, pass recreate_dir: true to recreate it empty (the conversation is restored from '
    + 'the transcript). Get the id from list_sessions or the archived Search view.',
  inputSchema: {
    target: z.string().min(1).describe('Session id (card id) to restore.'),
    recreate_dir: z.boolean().optional().describe('Recreate the session\'s launch directory if it was deleted. Default false.'),
  },
  async handler({ deps }, args = {}) {
    const target = (args.target ?? '').trim();
    if (!target) return errorResult('target is required.');
    if (!deps.sessionManager.entryFor(target)) {
      return errorResult(`Unknown session ${target} — no such session.`);
    }
    if (deps.sessionFromGraph?.(target)?.tmux) {
      return errorResult(`Session ${target} is already live.`);
    }
    const replies = [];
    const ctx = { ...deps, reply: (m) => replies.push(m) };
    await resumeSession(target, ctx, { recreateDir: args.recreate_dir === true });
    const needsDir = replies.find((m) => m.type === 'resume-needs-dir');
    if (needsDir) {
      return errorResult(`Launch directory ${needsDir.dir} no longer exists — retry with recreate_dir: true to recreate it.`);
    }
    const structuredContent = { target, restored: true };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
