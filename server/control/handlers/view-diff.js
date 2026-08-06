import { workingTreeDiff, branchDiff } from '../../git-diff.js';
import { lastCwd } from '../../transcript-reader.js';

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
      let result = mode === 'branch' ? await branchDiff(cwd) : await workingTreeDiff(cwd);
      let drift = null;
      // entry.cwd/worktree.path is frozen at launch (transcript-reader.js's
      // launchCwd deliberately reads the FIRST transcript record, so --resume keeps
      // finding its project bucket) — a session that cd's into a sibling repo and
      // stays there strands that repo with no diff-view path to it. Only reach for
      // the transcript's last recorded cwd when the launch dir itself isn't a repo
      // — never override a real (if empty) diff in the launch dir with a stale one.
      if (result.state === 'not-a-repo') {
        const driftedCwd = await lastCwd(entry?.liveSessionId || sessionId, ctx.projectsDir);
        if (driftedCwd && driftedCwd !== cwd) {
          const driftedResult = mode === 'branch' ? await branchDiff(driftedCwd) : await workingTreeDiff(driftedCwd);
          if (driftedResult.state !== 'not-a-repo') {
            result = driftedResult;
            drift = driftedCwd;
          }
        }
      }
      ctx.reply({ type: 'diff', sessionId, reqId, mode, ...result, cwd: drift || undefined });
    } catch (err) {
      ctx.reply({ type: 'diff', sessionId, reqId, mode, state: 'error', error: String(err.message || err) });
    }
  },
};
