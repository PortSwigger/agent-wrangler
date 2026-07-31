import { z } from 'zod';
import { detachError } from '../../control/handlers/detach.js';

// Promote a nested child session to a full top-level session — the
// session-to-session counterpart to the board's "Promote to full session"
// action. Refuses on a workflow worker (tracked by its orchestrator's
// autopilot run) — the same guard the board action uses.
export const detachSessionTool = {
  name: 'detach_session',
  description:
    'Promote a nested child session to a full top-level session by clearing its parent link. '
    + 'Refuses if the session is a workflow worker (tracked by its orchestrator) or isn\'t '
    + 'currently nested. Get the target id from list_sessions.',
  inputSchema: {
    session_id: z.string().min(1).describe('Session id (card id) to promote.'),
  },
  async handler({ deps }, args = {}) {
    const sessionId = (args.session_id ?? '').trim();
    if (!sessionId) return errorResult('session_id is required.');
    const error = detachError(sessionId, deps.sessionManager);
    if (error) return errorResult(error);
    deps.sessionManager.detachSession(sessionId);
    await deps.rebuild?.();
    const structuredContent = { session_id: sessionId, detached: true };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
