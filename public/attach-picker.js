// Pure helpers for the "Attach to…" picker, split out of app.js so they're
// unit-testable without a DOM (mirrors archive-cascade.js). `taskOf(sessionId)`
// resolves the same live-task id app.js's assignedTaskId does — injected
// rather than imported so this module stays DOM-free and independently
// testable.

import { descendantsOf } from './archive-cascade.js';

// Sessions `sessionId` could attach under: same task/bucket (including two
// sessions both with no task, where taskOf returns null for both), excluding
// itself, its CURRENT parent (re-attaching to the same parent is a no-op, not a
// real option), and its own descendants at any depth (attaching under one would
// make a cycle). Nesting has no depth limit, so a target that is itself nested
// is fine, and a session with children of its own can move — they go with it.
// Alphabetical by label.
export function attachCandidates(sessionId, sessions, taskOf) {
  const taskId = taskOf(sessionId);
  const currentParent = sessions.find((s) => s.sessionId === sessionId)?.parentSession;
  const below = new Set(descendantsOf(sessionId, sessions).map((d) => d.sessionId));
  return sessions
    .filter((c) => c.sessionId !== sessionId && c.sessionId !== currentParent && !below.has(c.sessionId) && taskOf(c.sessionId) === taskId)
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
}

// How many parentSession links deep `s` currently sits, walked over `byId`
// (Map<sessionId, session>) — used to indent a candidate's label in the
// picker so it shows the tree shape being chosen into. `seen` breaks a cycle
// deterministically rather than recursing forever (defense in depth — the
// mutation-side guard should make a cycle unreachable in practice).
export function nestingDepth(s, byId, seen = new Set()) {
  if (!s || !s.parentSession || seen.has(s.sessionId)) return 0;
  const parent = byId.get(s.parentSession);
  if (!parent) return 0;
  seen.add(s.sessionId);
  return 1 + nestingDepth(parent, byId, seen);
}

// Order candidates for the picker: the recorded spawner (entry.spawnedBy), if
// it's a valid candidate, first — everyone else keeps attachCandidates' own
// alphabetical order.
export function orderAttachCandidates(candidates, spawnedBy) {
  if (!spawnedBy) return candidates;
  const idx = candidates.findIndex((c) => c.sessionId === spawnedBy);
  if (idx <= 0) return candidates;
  const copy = [...candidates];
  const [spawner] = copy.splice(idx, 1);
  return [spawner, ...copy];
}
