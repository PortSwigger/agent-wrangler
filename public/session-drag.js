// Pure helpers for dragging a session onto another to nest it, and for
// reordering nested children, split out of app.js so they're unit-testable
// without a DOM (mirrors task-drag.js). `taskOf` is injected for the same
// reason attach-picker.js takes it.
import { attachCandidates } from './attach-picker.js';

// Share of a card's height, at its top and at its bottom, that still reorders.
// Only the middle band between them nests, so a drag can still slot a card
// above or below a neighbour without nesting into it by accident.
export const NEST_EDGE = 0.25;

// True when viewport-Y `y` is in the nesting band of `rect`.
export function inNestBand(rect, y) {
  const edge = rect.height * NEST_EDGE;
  return y > rect.top + edge && y < rect.bottom - edge;
}

// Whether dropping `sessionId` onto `targetId` may nest it there. Uses the
// "Attach to…" picker's own candidate list, so a drag can offer exactly the
// targets the menu does (same task, one level deep, not its current parent).
export function canNestOnto(sessionId, targetId, sessions, taskOf) {
  if (!sessionId || !targetId || sessionId === targetId) return false;
  return attachCandidates(sessionId, sessions, taskOf).some((c) => c.sessionId === targetId);
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
