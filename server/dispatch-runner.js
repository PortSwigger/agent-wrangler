import { workflowLaunchPrompt } from './workflow.js';
import { slugFromIntent } from './worktree.js';

// The shared "perform a dispatch" routine, extracted verbatim from the dispatch
// control handler so the scheduler fires the EXACT same path — a scheduled
// dispatch and a manual one can't drift. It mints the card id (via
// sessionManager.dispatch, which runs bindMemory pre-launch), wraps the autopilot
// issue, forces an auto worktree for workflow runs, and assigns the task. It does
// NOT rebuild or reply — callers (the /ws handler, the firing engine) own that.
//
// opts = { cwd, intent, model, agent, runtime, taskId, addDirs, worktree, worktreeBranch,
//          worktreeFolderName, worktreeAuto, workflow, autoMergeOnPass, parentSession,
//          cloudEnvironmentId, cloudRef }
// (the two cloud fields are inert unless `runtime === 'cloud'`; they ride here so the
// WS dispatch handler, schedules and spawn_session all carry them identically —
// nothing may reach sessionManager.dispatch by a path that drops them)
// (`addDirs` is part of the contract but neither the dispatch dialog nor the
// schedule UI exposes it, so it resolves to [] when absent.)
// Nesting only ever renders one level deep (computeAbsorption in
// public/workflow.js pops a grandchild back out to top-level) — refuse a
// brand-new parentSession that would create a session at depth > 1, rather
// than let the data reach a state the board can't draw. Exported so every
// place that can mint a NEW parentSession value shares this one check:
// runDispatch below (the peer-review dispatch dialog, a scheduled dispatch)
// AND spawn-session.js's `nest: true` handler, which dispatches via
// deps.dispatch → sessionManager.dispatch directly and does NOT go through
// runDispatch. Attach has its own equivalent guard in attachError for the
// one path that moves an EXISTING session instead. TODO: relax once
// recursive nested rendering ships (see the deferred follow-up plan).
export function nestedParentError(sessionManager, parentSessionId) {
  if (!parentSessionId) return null;
  if (sessionManager.entryFor(parentSessionId)?.parentSession) {
    return `Cannot nest under ${parentSessionId} — it is itself nested under another session, and the board only renders one level of nesting today.`;
  }
  return null;
}

export async function runDispatch(opts, { sessionManager, taskStore, memoryStore }, now = Date.now()) {
  const nestErr = nestedParentError(sessionManager, opts.parentSession);
  if (nestErr) throw new Error(nestErr);
  // Autopilot (issue→PR) mode: wrap the raw issue into a skill-naming imperative
  // (so the run goes through the tracked procedure, not freelance prose) and force
  // a fresh auto worktree on — a fleet of runs must never share a checkout. We pass
  // worktree directly here rather than via a client checkbox, and seed the branch
  // from the raw issue so a Jira key / short task gives a clean slug (the wrapped
  // prompt would otherwise slug to "use-issue-to-pr-skill").
  const workflow = Boolean(opts.workflow);
  const rawIssue = opts.intent || '';
  const intent = workflow ? workflowLaunchPrompt(rawIssue) : rawIssue;
  const { sessionId } = await sessionManager.dispatch({
    cwd: opts.cwd,
    intent,
    model: opts.model,
    effort: opts.effort,
    agent: opts.agent || 'claude',
    runtime: opts.runtime || 'local',
    cloudEnvironmentId: opts.cloudEnvironmentId || '',
    cloudRef: opts.cloudRef || '',
    addDirs: opts.addDirs || [],
    worktree: workflow ? true : Boolean(opts.worktree),
    worktreeBranch: workflow ? slugFromIntent(rawIssue) : (opts.worktreeBranch || ''),
    worktreeFolderName: workflow ? '' : (opts.worktreeFolderName || ''),
    worktreeAuto: workflow ? true : Boolean(opts.worktreeAuto),
    autoMergeOnPass: opts.autoMergeOnPass ? true : undefined,
    workflow: workflow
      ? { issue: rawIssue, phase: { label: 'starting', kind: 'active', at: now }, startedAt: now }
      : (opts.workflow || undefined),
    parentSession: opts.parentSession || undefined,
    // Repoint the memory symlink before the process launches — the agent reads
    // AW_TASK_MEMORY / --add-dir at boot — keyed on the chosen task (opts.taskId,
    // before the assign below lands).
    bindMemory: (sid) => memoryStore.bindSession(sid, opts.taskId || null),
  });
  // Optional task targeting: assign is a no-op if the task was deleted between
  // saving and firing, so the session just falls back to Ad hoc.
  if (opts.taskId) taskStore.assign(sessionId, opts.taskId);
  return { sessionId };
}
