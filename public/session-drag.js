// Pure helpers for dragging a session to nest it, move it between parents,
// or reorder nested children, split out of app.js so they're unit-testable
// without a DOM (mirrors task-drag.js). `taskOf` is injected for the same
// reason attach-picker.js takes it.
import { attachCandidates } from './attach-picker.js';

// Whether `sessionId` may be nested under `targetId`, by a drop on the
// target's Nest zone or into its child spine. Uses the "Attach to…" picker's
// own candidate list, so a drag offers exactly the targets the menu does
// (same task, one level deep, not its current parent).
export function canNestOnto(sessionId, targetId, sessions, taskOf) {
  if (!sessionId || !targetId || sessionId === targetId) return false;
  return attachCandidates(sessionId, sessions, taskOf).some((c) => c.sessionId === targetId);
}

// What a same-task drop at the placeholder does to the dragged session's
// parent link, besides storing the new order:
// - 'attach' — it landed in another parent's spine (`spineParent`);
// - 'promote' — a child drawn in a spine (`drawnAsChild`) landed among the
//   top-level cards;
// - null — the parent link stays as it is (a plain reorder).
export function childDropAction({ spineParent, currentParent, drawnAsChild }) {
  if (spineParent) return spineParent === currentParent ? null : 'attach';
  return drawnAsChild ? 'promote' : null;
}

// The bucket order to store after a drop. `next` is what the tile shows now,
// parents and their children in DOM order. Ids in `previous` that `next` does
// not show (a collapsed workflow's workers, a snoozed row) keep their earlier
// order after it, so a reorder never resets their position among siblings.
export function mergeSessionOrder(next, previous = []) {
  const seen = new Set();
  const out = [];
  for (const sid of [...next, ...previous]) {
    if (typeof sid !== 'string' || seen.has(sid)) continue;
    seen.add(sid);
    out.push(sid);
  }
  return out;
}
