import { launchTargetError } from './agents/index.js';
import { autoCompactTokensError } from './session-manager.js';
import { workflowLaunchPrompt } from './workflow.js';
import { slugFromIntent } from './worktree.js';
import { claimStagedPastes } from './paste-store.js';
import { prefillPane, sendText } from './tmux-scraper.js';
import { waitForComposerReady, ensureSubmitted } from './pane-ready.js';

// A first prompt that carries images, delivered the way a chat message with
// attachments is (message-delivery.js): each path as its own bracketed paste,
// then the prose, then one Enter — the only shape the TUI turns into inline
// images. Held until the freshly launched TUI has painted its composer, since a
// paste into a pane that is still booting is silently lost. Never throws: the
// session exists either way, and the intent is still on the card to resend.
export async function deliverFirstPrompt({ tmux, socket = '', agent, text, imagePaths }, deps = {}) {
  const {
    waitReady = waitForComposerReady, prefill = prefillPane, send = sendText, confirm = ensureSubmitted,
    log = (m) => console.error(m),
  } = deps;
  try {
    await waitReady(tmux, socket, agent);
    for (const p of imagePaths) await prefill(tmux, p, socket);
    await send(tmux, text, socket);
    // An image-only prompt leaves just `[Image #1]` in the composer, so that is
    // what the submit check looks for when there is no prose to find.
    if (!await confirm(tmux, socket, { text: text || (imagePaths.length ? '[Image #1]' : ''), agent })) log(`[dispatch] first prompt with images may not have been submitted in ${tmux}`);
  } catch (err) {
    log(`[dispatch] could not deliver the first prompt with images to ${tmux}: ${err?.message || err}`);
  }
}

// The shared "perform a dispatch" routine, extracted verbatim from the dispatch
// control handler so the scheduler fires the EXACT same path — a scheduled
// dispatch and a manual one can't drift. It mints the card id (via
// sessionManager.dispatch, which collects the launch context pre-launch), wraps the autopilot
// issue, forces an auto worktree for workflow runs, and assigns the task. It does
// NOT rebuild or reply — callers (the /ws handler, the firing engine) own that.
//
// opts = { cwd, intent, model, agent, runtime, taskId, addDirs, worktree, worktreeBranch,
//          worktreeFolderName, worktreeAuto, workflow, autoMergeOnPass, parentSession, imageNames }
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

export async function runDispatch(opts, { sessionManager, taskStore, deliverFirstPrompt: deliver = deliverFirstPrompt }, now = Date.now()) {
  const nestErr = nestedParentError(sessionManager, opts.parentSession);
  if (nestErr) throw new Error(nestErr);
  // Both callers can carry an agent/model this install doesn't offer, and both
  // have somewhere to report it: the /ws dispatch handler turns a throw into the
  // dialog's {type:'error'}, and fireSchedule catches it into a `schedule-error`
  // broadcast. That error channel is why validation belongs here and not only at
  // schedule-creation time — a schedule stored while a model existed still fires
  // months after that model is retired from an adapter, and launching it on the
  // ambient default (or into a pane that dies) is worse than saying so.
  // Deliberately NOT the spawn path: performSpawn dispatches through
  // sessionManager.dispatch directly, so a caller-INHERITED legacy model never
  // reaches here and keeps working (see performSpawn's own comment).
  const badTarget = launchTargetError(opts.agent || 'claude', opts.model);
  if (badTarget) throw new Error(badTarget);
  const autoCompactError = autoCompactTokensError(opts.autoCompactTokens, opts.agent || 'claude');
  if (autoCompactError) throw new Error(autoCompactError);
  // Autopilot (issue→PR) mode: wrap the raw issue into a skill-naming imperative
  // (so the run goes through the tracked procedure, not freelance prose) and force
  // a fresh auto worktree on — a fleet of runs must never share a checkout. We pass
  // worktree directly here rather than via a client checkbox, and seed the branch
  // from the raw issue so a Jira key / short task gives a clean slug (the wrapped
  // prompt would otherwise slug to "use-issue-to-pr-skill").
  const workflow = Boolean(opts.workflow);
  const rawIssue = opts.intent || '';
  const intent = workflow ? workflowLaunchPrompt(rawIssue) : rawIssue;
  // Images pasted into the intent box (staged by paste-image's `staged` mode).
  // They need the pane composer, so the intent is held back from the launch
  // command and pasted after the TUI boots, images first.
  const imageNames = Array.isArray(opts.imageNames) ? opts.imageNames : [];
  const withImages = imageNames.length > 0;
  // A container or remote runtime cannot read the host's pastes dir.
  if (withImages && (opts.runtime || 'local') !== 'local') throw new Error('Images in the first prompt need a local launch.');
  const { sessionId, tmux } = await sessionManager.dispatch({
    cwd: opts.cwd,
    intent,
    model: opts.model,
    effort: opts.effort,
    autoCompactTokens: opts.autoCompactTokens,
    agent: opts.agent || 'claude',
    runtime: opts.runtime || 'local',
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
    // Extension-owned data from the dialog's dispatch.field contributions
    // (`ext.<extId>`), handed to each extension's onBeforeDispatch as its own
    // slice. A scheduled dispatch stores the payload whole, so it rides along.
    ext: opts.ext && typeof opts.ext === 'object' && !Array.isArray(opts.ext) ? opts.ext : undefined,
    // The chosen task, handed to dispatch so the launch context
    // (session.launchContext) sees it before the process launches — i.e. before
    // the assign below lands.
    taskId: opts.taskId || undefined,
    deferIntent: withImages || undefined,
  });
  let firstPrompt;
  if (withImages) {
    const agent = opts.agent || 'claude';
    const imagePaths = claimStagedPastes(sessionId, agent, imageNames);
    // Not awaited: the dialog closes on the dispatch ack, and the TUI can take
    // seconds to boot. Returned so a test can wait for it.
    firstPrompt = deliver({ tmux, socket: sessionManager.entryFor(sessionId)?.socket ?? '', agent, text: intent, imagePaths });
  }
  // Optional task targeting: assign is a no-op if the task was deleted between
  // saving and firing, so the session just falls back to Ad hoc.
  if (opts.taskId) taskStore.assign(sessionId, opts.taskId);
  return { sessionId, firstPrompt };
}
