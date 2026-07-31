import { z } from 'zod';
import { attachError } from '../../control/handlers/attach.js';

// Nest a session under another, on the SAME task — the session-to-session
// counterpart to the board's "Attach to…" action. Nesting only ever renders
// within one task tile, so this refuses a cross-task target rather than
// producing a link that renders nothing; move one session onto the other's
// task on the board first (there is no MCP tool for that today). Also
// refuses if it would create a cycle.
export const attachSessionTool = {
  name: 'attach_session',
  description:
    'Attach a session as a nested child of another session on the SAME task (nesting only '
    + 'renders within one task tile). Refuses if it would create a cycle, or if the two sessions '
    + 'are on different tasks — move one onto the other\'s task on the board first. Get ids from '
    + 'list_sessions.',
  inputSchema: {
    session_id: z.string().min(1).describe('Session id (card id) to attach.'),
    parent_session_id: z.string().min(1).describe('Session id (card id) to attach it under.'),
  },
  async handler({ deps }, args = {}) {
    const sessionId = (args.session_id ?? '').trim();
    const parentSessionId = (args.parent_session_id ?? '').trim();
    if (!sessionId) return errorResult('session_id is required.');
    if (!parentSessionId) return errorResult('parent_session_id is required.');
    const sessions = deps.graph?.()?.sessions || [];
    const error = attachError(sessionId, parentSessionId, { sessions, taskStore: deps.taskStore });
    if (error) return errorResult(error);
    deps.sessionManager.attachSession(sessionId, parentSessionId);
    await deps.rebuild?.();
    const structuredContent = { session_id: sessionId, parent_session_id: parentSessionId, attached: true };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
