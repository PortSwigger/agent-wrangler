// Resolve a session's live tmux target from the most recent graph (covers both
// app-launched and discovered sessions). Shared by the control handlers and the
// PTY channel — both attach to whatever the latest graph says owns the session.
// `getGraph` returns the mutable lastGraph; reading it through a getter keeps
// these resolvers honest as the board rebuilds.
export function createTargets(sessionManager, getGraph) {
  const sessionFromGraph = (sessionId) =>
    getGraph()?.sessions?.find((s) => s.sessionId === sessionId) || null;
  const tmuxFor = (sessionId) =>
    sessionFromGraph(sessionId)?.tmux || sessionManager.attachTargetFor(sessionId) || null;
  // The tmux socket a session's terminal lives on (default '' for legacy sessions).
  const socketFor = (sessionId) => {
    const node = sessionFromGraph(sessionId);
    if (node && node.socket != null) return node.socket;
    return sessionManager.socketOf?.(tmuxFor(sessionId)) ?? '';
  };
  return { sessionFromGraph, tmuxFor, socketFor };
}
