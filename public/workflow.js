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
// computed from the same set. A session is absorbed into a parent's spine iff
// it has a `parentSession` present in the SAME candidate set (an orphan — parent
// missing, e.g. assigned to a different task — falls back to its own top-level
// card). Nesting has no depth limit: a child of a child is absorbed too, and
// `childrenByParent` maps every present parent (at any depth) to its DIRECT
// children. Cycle-safe (a `parentSession` chain shouldn't cycle, but if one
// does, the member listed first in `sessions` stays top-level so the loop still
// renders from somewhere and nothing vanishes).
export function computeAbsorption(sessions) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const order = new Map(sessions.map((s, i) => [s.sessionId, i]));
  const cycleRoots = new Set();
  const state = new Map(); // 1 = on the current walk, 2 = resolved
  for (const start of sessions) {
    const path = [];
    let cur = start;
    while (cur && !state.has(cur.sessionId)) {
      state.set(cur.sessionId, 1);
      path.push(cur);
      cur = cur.parentSession ? byId.get(cur.parentSession) : null;
    }
    if (cur && state.get(cur.sessionId) === 1) {
      const cycle = path.slice(path.indexOf(cur));
      const first = cycle.reduce((a, b) => (order.get(b.sessionId) < order.get(a.sessionId) ? b : a));
      cycleRoots.add(first.sessionId);
    }
    for (const p of path) state.set(p.sessionId, 2);
  }
  const absorbed = new Set();
  const childrenByParent = new Map();
  for (const s of sessions) {
    if (!s.parentSession || !byId.has(s.parentSession) || cycleRoots.has(s.sessionId)) continue;
    absorbed.add(s.sessionId);
    const list = childrenByParent.get(s.parentSession) || [];
    list.push(s);
    childrenByParent.set(s.parentSession, list);
  }
  return { absorbed, childrenByParent };
}

// Indent steps drawn before a deep chain stops stepping right (the tree is
// unbounded; the tile is not): the fourth level of rows and everything below it
// share one indent.
export const MAX_SPINE_INDENT = 3;

// A parent's whole subtree as the flat, depth-first list of rows its spine draws.
// Each row: { session, depth, indent, more, guides }.
//  - depth: levels below the spine's owner (0 = a direct child).
//  - indent: depth clamped to MAX_SPINE_INDENT — how far right the row steps.
//  - more: this level's trunk keeps running past the row — a later sibling
//    exists, or the row's own children sit at the same capped indent and so hang
//    off the very same trunk.
//  - guides: how many indent steps LEFT of the row's own trunk each ancestor
//    trunk that is still running sits (an ancestor with later siblings), so a
//    deep row can draw the lines of the levels it is nested inside. 0 means an
//    ancestor past the indent cap shares the row's own trunk, which still has to
//    run through the row for a later sibling of that ancestor to join up.
export function spineRows(children, childrenByParent) {
  const rows = [];
  const walk = (list, depth, ancestorMore) => {
    list.forEach((session, i) => {
      const sibling = i < list.length - 1;
      const indent = Math.min(depth, MAX_SPINE_INDENT);
      const kids = childrenByParent.get(session.sessionId) || [];
      const more = sibling || (kids.length > 0 && indent === MAX_SPINE_INDENT);
      const guides = [];
      ancestorMore.forEach((running, level) => {
        const up = indent - Math.min(level, MAX_SPINE_INDENT);
        if (running && !guides.includes(up)) guides.push(up);
      });
      rows.push({ session, depth, indent, more, guides });
      if (kids.length) walk(kids, depth + 1, [...ancestorMore, sibling]);
    });
  };
  walk(children, 0, []);
  return rows;
}

// A tile's sessions as the DRAWN groups, in drawn order: each top-level session
// followed by its whole subtree. The flat stored order is NOT the visual one — a
// child renders at its ROOT's slot, however far apart the two sit in the flat
// list — so anything walking the board positionally (cards.js renders from this;
// app.js's keyboard nav flattens it) must go through here or it silently
// disagrees with what's on screen. `children` are the DIRECT children;
// `rows` is the full depth-first subtree (see spineRows) and `descendants` its
// sessions in the same order.
export function sessionGroups(sessions) {
  const { absorbed, childrenByParent } = computeAbsorption(sessions);
  return sessions
    .filter((s) => !absorbed.has(s.sessionId))
    .map((s) => {
      const children = childrenByParent.get(s.sessionId) || [];
      const rows = spineRows(children, childrenByParent);
      return { session: s, children, rows, descendants: rows.map((r) => r.session) };
    });
}
