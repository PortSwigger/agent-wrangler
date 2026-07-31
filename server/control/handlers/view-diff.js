import { workingTreeDiff, branchDiff } from '../../git-diff.js';

// Return the session's read-only diff to the requesting client only (ctx.reply,
// never broadcast). The directory is the worktree the agent runs in when the
// session has one (its changes live there), else the session's launch cwd; the
// graph node's cwd is a last resort for a session off the mapping. All git access
// is confined to the git-diff.js leaf — this handler never shells out.
// `msg.mode` picks the comparison: 'working-tree' (default — uncommitted changes
// only) or 'branch' (everything since the branch's remote lineage, committed and
// uncommitted alike). Echoed back on the reply so the client can match it to the
// toggle it was showing when the request went out.
export const viewDiffHandler = {
  type: 'view-diff',
  async handler(msg, ctx) {
    const { sessionId } = msg;
    // Echo the client's monotonic request id (when present) on every reply so the
    // client can drop stale/out-of-order diffs and settle its in-flight guard.
    // Absent on legacy clients — echoing `undefined` is inert (drops from JSON).
    const reqId = msg.reqId;
    const mode = msg.mode === 'branch' ? 'branch' : 'working-tree';
    try {
      const entry = ctx.sessionManager.entryFor(sessionId);
      const cwd = entry?.worktree?.path || entry?.cwd || ctx.sessionFromGraph(sessionId)?.cwd;
      if (!cwd) {
        ctx.reply({ type: 'diff', sessionId, reqId, mode, state: 'error', error: 'No working directory for this session.' });
        return;
      }
      const result = mode === 'branch' ? await branchDiff(cwd) : await workingTreeDiff(cwd);
      ctx.reply({ type: 'diff', sessionId, reqId, mode, ...result });
    } catch (err) {
      ctx.reply({ type: 'diff', sessionId, reqId, mode, state: 'error', error: String(err.message || err) });
    }
  },
};
