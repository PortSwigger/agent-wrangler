// Pure helper for the autopilot phase shown in the card's status bar, split out
// of app.js so it's unit-testable without a DOM (model: snooze.js). Returns the
// trimmed phase label, or null when there's no workflow marker / no labelled
// phase yet (so the bar falls back to the normal status word).
export function workflowPhaseLabel(workflow) {
  const label = workflow && workflow.phase && workflow.phase.label;
  if (!label || !String(label).trim()) return null;
  return String(label).trim();
}

// An ORCHESTRATOR (an issue→PR autopilot run) carries a `workflow` marker
// ({issue, phase, startedAt}) — the run the board wraps in the violet workflow
// box. A WORKER it spawned carries the generic `parentSession` link (see the
// child-sessions design) pointing at the orchestrator's card id, with no
// `workflow` of its own — nesting under an orchestrator is what makes it a
// worker specifically, as opposed to any other nested child (e.g. a review).
// Split out as pure predicates so the grouping in app.js/cards.js
// is unit-testable. `byId` is a Map<sessionId, session> over the candidate set,
// needed to resolve whether a child's parent is itself an orchestrator.
export function isWorkflowRun(s) {
  return Boolean(s && s.workflow);
}
export function isWorkflowWorker(s, byId) {
  return Boolean(s?.parentSession) && isWorkflowRun(byId.get(s.parentSession));
}

// Shared by cards.js (renderTileCards) and layout.js (tile-height weighting) so
// the two agree on exactly which sessions fold into a parent's spine — they must
// never drift, since the rendered spine and the height reserved for it are
// computed from the same set. A session is absorbed into its parent's spine iff
// it has a `parentSession` present in the SAME candidate set (an orphan — parent
// missing, e.g. assigned to a different task — falls back to its own top-level
// card) AND that parent itself renders top-level (recursive: a chained
// grandchild whose immediate parent is itself absorbed elsewhere promotes to its
// own top-level slot instead — nesting renders only one level deep). Cycle-safe
// (a `parentSession` chain shouldn't cycle, but this never hangs if one does).
export function computeAbsorption(sessions) {
  const present = new Set(sessions.map((s) => s.sessionId));
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const cache = new Map();
  const isAbsorbed = (s) => {
    if (!s || !s.parentSession || !present.has(s.parentSession)) return false;
    if (cache.has(s.sessionId)) return cache.get(s.sessionId);
    cache.set(s.sessionId, false); // cycle guard
    const result = !isAbsorbed(byId.get(s.parentSession));
    cache.set(s.sessionId, result);
    return result;
  };
  const absorbed = new Set();
  const childrenByParent = new Map();
  for (const s of sessions) {
    if (isAbsorbed(s)) {
      absorbed.add(s.sessionId);
      const list = childrenByParent.get(s.parentSession) || [];
      list.push(s);
      childrenByParent.set(s.parentSession, list);
    }
  }
  return { absorbed, childrenByParent };
}
