import { descendantsOf } from './archive.js';

// Nest a session under another — the board's "Attach to…" action and the
// attach_session MCP tool share this same guard so neither path can bypass
// the other's cycle/same-task checks. Nesting is unbounded in depth but only
// renders within one task tile (renderTileCards computes absorption per-tile),
// so a cross-task attach would set parentSession but render nothing nested —
// refused outright rather than building task-reassignment logic. The moved
// session's own children travel with it.
export function attachError(sessionId, parentSessionId, { sessions, taskStore }) {
  if (!sessionId || !parentSessionId) return 'session_id and parent_session_id are required.';
  if (sessionId === parentSessionId) return 'A session cannot be attached to itself.';
  if (!sessions.some((s) => s.sessionId === sessionId)) return `Unknown session ${sessionId} — no such session on the board.`;
  if (!sessions.some((s) => s.sessionId === parentSessionId)) return `Unknown session ${parentSessionId} — no such session on the board.`;
  const selfEntry = sessions.find((s) => s.sessionId === sessionId);
  if (selfEntry?.parentSession === parentSessionId) {
    return `${sessionId} is already attached to ${parentSessionId} — nothing to do.`;
  }
  const descendants = descendantsOf(sessionId, sessions);
  if (descendants.some((d) => d.sessionId === parentSessionId)) {
    return `Cannot attach — ${parentSessionId} is already a descendant of ${sessionId}; this would create a cycle.`;
  }
  const sessionTask = taskStore.taskFor(sessionId);
  const parentTask = taskStore.taskFor(parentSessionId);
  if ((sessionTask?.id ?? null) !== (parentTask?.id ?? null)) {
    return `Cannot attach across tasks — ${sessionId} is on ${sessionTask ? sessionTask.name : 'Ad-hoc'} and ${parentSessionId} is on ${parentTask ? parentTask.name : 'Ad-hoc'}. Move one onto the other's task first.`;
  }
  return null;
}

export const attachHandler = {
  type: 'attach',
  async handler(msg, ctx) {
    const sessions = ctx.graph?.()?.sessions || [];
    const error = attachError(msg.sessionId, msg.parentSessionId, { sessions, taskStore: ctx.taskStore });
    if (error) { ctx.reply({ type: 'error', message: error }); return; }
    ctx.sessionManager.attachSession(msg.sessionId, msg.parentSessionId);
    await ctx.rebuild();
  },
};
