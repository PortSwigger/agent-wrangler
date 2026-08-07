import { sendText, capturePane, hasBackgroundShell } from '../../tmux-scraper.js';
import { stopContainer } from '../../runtimes/devcontainer.js';

// Nudged into the pane before its terminal is torn down with a background job still
// running — shared by archive (solo + cascade) and restart, since both kill the live
// pane. Wording is deliberately NEUTRAL ("terminal is about to be closed") so it's
// accurate whichever teardown is happening; the agent's required action — stop the job
// now — is identical either way, so there's no need for archive/restart to diverge.
// Claude has a proper tool call for this (KillShell/TaskStop) that leaves a durable
// transcript entry — unlike the client-side /tasks panel, which leaves zero trace and
// is exactly what produces "No completion record was found" noise on the next resume.
// Codex has no equivalent dedicated tool (confirmed empirically: `write_stdin` can
// only send Ctrl-C when the async command was started with a tty, which isn't
// guaranteed, and its own `/stop` is a client-side action with the same
// zero-transcript-trace problem) — so this is a best-effort ask, not a guaranteed
// clean stop. Either way the bounded wait below tolerates it not clearing.
export const KILL_JOBS_NUDGE = {
  claude: "Heads up — this session's terminal is about to be closed. Please stop any running background shell(s) now via the KillShell tool.",
  codex: "Heads up — this session's terminal is about to be closed. Please stop your background job(s) now if you can.",
};
const KILL_JOBS_TIMEOUT_MS = 15000;
const KILL_JOBS_POLL_MS = 1000;

// Poll the pane until its "a background job is running" marker (agent-specific —
// see hasBackgroundShell in tmux-scraper.js) clears or the timeout elapses.
// Capture/detect/sleep are injectable so this is unit-testable without a real
// tmux pane or real timers.
export async function waitForBackgroundShellClear(tmux, socket, {
  agent = 'claude',
  timeoutMs = KILL_JOBS_TIMEOUT_MS,
  pollMs = KILL_JOBS_POLL_MS,
  capturePaneFn = capturePane,
  detectFn = (paneText) => hasBackgroundShell(paneText, agent),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!detectFn(await capturePaneFn(tmux, 60, socket))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

// Best-effort stop of a live pane's background job(s) before its terminal is torn
// down: nudge the agent (KILL_JOBS_NUDGE), then wait (bounded) for the marker to
// clear. Returns true if it cleared in time, false if it timed out. The single home
// for the nudge + agent default + socket fallback, so every teardown that kills a live
// pane (archive solo + cascade, restart) resolves them identically and can't silently
// drift. `session` is the graph node / mapping-shaped object the caller already holds
// (its `.agent`/`.socket` are the fallbacks); `id` is the card id the socket is looked
// up by. Callers differ only in how they interpret the returned boolean.
export async function nudgeAndWaitForJobs(tmux, session, { ctx, id } = {}) {
  const agent = session?.agent || 'claude';
  const socket = ctx?.socketFor?.(id) ?? session?.socket ?? '';
  await sendText(tmux, KILL_JOBS_NUDGE[agent] || KILL_JOBS_NUDGE.claude, socket).catch(() => {});
  return waitForBackgroundShellClear(tmux, socket, { agent });
}

// The transitive closure of `parentSession` links under `target`, walked over
// `sessions` (board nodes — either the live graph or an archived-tree candidate
// list). "Descendant" is transitive, not just direct children, since a spawned
// child can itself have children (chaining — see the child-sessions design).
export function descendantsOf(target, sessions) {
  const childrenOf = new Map();
  for (const s of sessions) {
    if (s.parentSession) {
      const list = childrenOf.get(s.parentSession) || [];
      list.push(s);
      childrenOf.set(s.parentSession, list);
    }
  }
  const result = [];
  const seen = new Set();
  const queue = [target];
  while (queue.length) {
    const id = queue.shift();
    for (const child of childrenOf.get(id) || []) {
      if (seen.has(child.sessionId)) continue;
      seen.add(child.sessionId);
      result.push(child);
      queue.push(child.sessionId);
    }
  }
  return result;
}

// Archive a list of session ids in order, auto-detecting each one's OWN live
// background shell (via the graph's `hasBackgroundShell`) rather than trusting a
// blanket flag — the "no human to ask, always take the safe path" pattern the
// archive_session MCP tool already used for a single target, now shared with the
// board's cascade ("Archive all") so both callers tear down a tree identically.
// (The board's SOLO archive path is deliberately separate — see archiveHandler
// below — because there a human already confirmed via the 3-way dialog.)
export async function archiveCascade(ids, ctx, { viaTaskArchive } = {}) {
  let unclean = false;
  for (const id of ids) {
    const node = ctx.sessionFromGraph?.(id) ?? null;
    if (node?.hasBackgroundShell) {
      const tmux = ctx.tmuxFor?.(id);
      if (tmux && !(await nudgeAndWaitForJobs(tmux, node, { ctx, id }))) unclean = true;
    }
    try {
      // Kill every owned tmux hosting this session (original + any forks), not just
      // the recorded name, so archiving never leaves a live orphan. Fall back to a
      // direct pid kill when no owned tmux was found but the graph still reports
      // one (parity with the board's solo archive path below).
      const killed = await ctx.sessionManager.killForSession(id);
      if (!killed?.length && node?.pid) process.kill(node.pid, 'SIGTERM');
    } catch {
      /* process may already be gone — archive anyway */
    }
    ctx.sessionManager.archive(id, {
      cwd: node?.cwd,
      intent: node?.intent || node?.label,
      label: node?.label,
      task: ctx.taskStore.taskFor(id),
      // Only present for a task-archive cascade — omitted (not just falsy) for a
      // plain descendant cascade, so the snapshot shape is unchanged everywhere
      // else that inspects it.
      ...(viaTaskArchive ? { viaTaskArchive } : {}),
    });
  }
  return { unclean };
}

// Whether another tracked devcontainer session (not in `ignoreIds`) still points
// at `cwd` — the same-container safety guard for the "stop container on archive"
// offer. A dispatch/resume/fork against the same repo all reuse ONE container
// (keyed on the workspace dir via the devcontainer.local_folder label), so the
// container must NOT be stopped while a sibling session still uses it — exactly
// as the worktree-deletion offer is withheld while another session shares the cwd
// (see public/archive-cascade.js's worktreeStillInUse). `sessions` are
// mapping/graph nodes carrying { sessionId, runtime, cwd }; `ignoreIds` excludes
// the session(s) archived in the same operation (target + cascade descendants),
// so the check ignores the very sessions this archive is taking down. A parallel
// copy lives in public/archive-cascade.js — public/ and server/ never cross-import,
// so both keep their own (like descendantsOf).
export function containerStillInUse(cwd, sessions, ignoreIds = []) {
  const ignore = new Set(ignoreIds);
  return sessions.some((s) => !ignore.has(s.sessionId) && s.runtime === 'devcontainer' && s.cwd === cwd);
}

// Stop the Docker container an archived devcontainer session brought up — the
// server side of the toast's "Stop container" offer (public/app.js), mirroring
// the worktree-remove handler: the client offers it, this does it. Only ever
// invoked after the session is archived, so activeEntries() no longer counts it;
// the same-cwd guard below then withholds the stop while ANOTHER live devcontainer
// session still shares the container (see containerStillInUse). Leaving it running
// keeps resume fast, so stopping is always the user's explicit choice — never a
// side effect of archive itself.
export const stopContainerHandler = {
  type: 'stop-container',
  async handler(msg, ctx) {
    const entry = ctx.sessionManager.entryFor(msg.sessionId);
    if (entry?.runtime !== 'devcontainer' || !entry.cwd) {
      ctx.reply({ type: 'error', message: 'This session has no devcontainer to stop.' });
      return;
    }
    if (containerStillInUse(entry.cwd, ctx.sessionManager.activeEntries(), [msg.sessionId])) {
      ctx.reply({ type: 'error', message: 'Another active session is still using this container — leaving it running.' });
      return;
    }
    // ctx.stopContainer overrides the real docker-shelling helper in tests; absent
    // in production, so the server wires nothing.
    const cid = await (ctx.stopContainer || stopContainer)(entry.cwd, {});
    ctx.reply({ type: 'container-stopped', sessionId: msg.sessionId, stopped: Boolean(cid) });
  },
};

export const archiveHandler = {
  type: 'archive',
  async handler(msg, ctx) {
    // Cascade ("Archive all" in the descendants dialog): resolve the full
    // transitive descendant set from the live graph, archive descendants-first
    // then the target, all within this one handler call, then a SINGLE rebuild —
    // so the client's board state never reflects a half-torn-down tree (see the
    // worktree-deletion safety guard in app.js, which depends on this).
    if (msg.cascade) {
      const sessions = ctx.graph?.()?.sessions || [];
      const descendants = descendantsOf(msg.sessionId, sessions);
      const ids = [...descendants.map((d) => d.sessionId), msg.sessionId];
      const { unclean } = await archiveCascade(ids, ctx);
      setTimeout(() => ctx.rebuild().catch(() => {}), 600);
      // Always reply for a cascade — unlike the solo path below (gated on
      // killJobsFirst, which only fires when there was something to nudge), the
      // client needs to know the WHOLE tree is down regardless: its
      // worktree-cleanup guard (public/app.js) depends on `childIds` to exclude
      // every archived descendant from its "still in use" check, and today's only
      // caller always pairs cascade with killJobsFirst anyway.
      ctx.reply({
        type: 'archived', sessionId: msg.sessionId, unclean,
        archivedChildren: descendants.length,
        childIds: descendants.map((d) => d.sessionId),
      });
      return;
    }
    // Set a session aside: stop its process but keep the (stamped) mapping so it
    // stays resumable (archived; findable in Search). Archive even if the process
    // is already gone.
    const s = ctx.sessionFromGraph(msg.sessionId);
    // "Kill jobs & archive" (the client's 3-way confirm when a background shell is
    // live): nudge the agent to stop it itself FIRST, then wait briefly before the
    // teardown below. If it doesn't clear in time we archive anyway rather than
    // block forever — `unclean` tells the client whether to say so.
    let unclean = false;
    if (msg.killJobsFirst && s?.tmux) {
      unclean = !(await nudgeAndWaitForJobs(s.tmux, s, { ctx, id: msg.sessionId }));
    }
    try {
      // Kill every owned tmux hosting this session (original + any forks), not just
      // the recorded name, so archiving never leaves a live orphan.
      const killed = await ctx.sessionManager.killForSession(msg.sessionId);
      if (!killed.length && s?.pid) process.kill(s.pid, 'SIGTERM');
    } catch {
      /* process may already be gone — archive anyway */
    }
    ctx.sessionManager.archive(msg.sessionId, {
      cwd: s?.cwd,
      intent: s?.intent || s?.label,
      label: s?.label,
      task: ctx.taskStore.taskFor(msg.sessionId),
    });
    // Keep the task assignment: while archived the session is off the board (so no
    // stale card renders), and on resume it returns to its original tile and slot.
    // Permanent `remove` is what unassigns.
    setTimeout(() => ctx.rebuild().catch(() => {}), 600);
    if (msg.killJobsFirst) ctx.reply({ type: 'archived', sessionId: msg.sessionId, unclean });
  },
};
