// Promote a nested child to a full top-level session by clearing its parent
// link — the board's "Promote to full session" action and the detach_session
// MCP tool share this same guard so neither path can bypass the other's
// workflow-worker check.
export function detachError(sessionId, sessionManager) {
  const entry = sessionManager.entryFor(sessionId);
  if (!entry) return `Unknown session ${sessionId} — no such session on the board.`;
  if (!entry.parentSession) return `${sessionId} is already a full top-level session — nothing to promote.`;
  const parentEntry = sessionManager.entryFor(entry.parentSession);
  if (parentEntry?.workflow) {
    return `Cannot promote ${sessionId} — it is a workflow worker tracked by orchestrator ${entry.parentSession}; promoting it would desync that autopilot run.`;
  }
  return null;
}

export const detachHandler = {
  type: 'detach',
  async handler(msg, ctx) {
    const error = detachError(msg.sessionId, ctx.sessionManager);
    if (error) { ctx.reply({ type: 'error', message: error }); return; }
    ctx.sessionManager.detachSession(msg.sessionId);
    await ctx.rebuild();
  },
};
