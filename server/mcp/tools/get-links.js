import { z } from 'zod';

// Read the caller's links. `scope` selects task / session / both (default both).
// Caller is the card id; the task is resolved at call time (reassignment-safe).
export const getLinksTool = {
  name: 'get_links',
  description:
    'Read the links recorded on your current task and/or your session. Returns each '
    + 'link as {type:"jira", key, url}. Call this before set_links/remove_links so you '
    + 'replace the full list without dropping links you did not know about. scope: '
    + '"task", "session", or omit for both.',
  inputSchema: {
    scope: z.enum(['task', 'session']).optional().describe('Which scope to read; omit for both.'),
  },
  async handler({ deps, caller }, args = {}) {
    const scope = args.scope;
    const structuredContent = {};
    if (scope !== 'session') {
      const task = caller != null ? deps.taskStore.taskFor(caller) : null;
      structuredContent.task = task ? { id: task.id, name: task.name, links: deps.taskStore.getLinks(task.id) } : null;
    }
    if (scope !== 'task') {
      structuredContent.session = { sessionId: caller ?? null, links: caller != null ? deps.sessionManager.getLinks(caller) : [] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};
