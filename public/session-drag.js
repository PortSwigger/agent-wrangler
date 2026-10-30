// Pure helpers for dragging a session onto another to nest it, and for
// reordering nested children, split out of app.js so they're unit-testable
// without a DOM (mirrors task-drag.js). `taskOf` is injected for the same
// reason attach-picker.js takes it.
import { attachCandidates } from './attach-picker.js';

// Share of a card's height, at its top and at its bottom, that never nests.
// Only a hold in the middle band between them nests (see createNestDwell).
export const NEST_EDGE = 0.25;

// True when viewport-Y `y` is in the nesting band of `rect`.
export function inNestBand(rect, y) {
  const edge = rect.height * NEST_EDGE;
  return y > rect.top + edge && y < rect.bottom - edge;
}

// How long a drag must hold over a card's nesting band before a drop nests.
// Until then the drag reorders exactly as it always has, so a quick drag
// through or onto the middle of a card never nests by accident.
export const NEST_DWELL_MS = 600;

// Tracks how long a drag has held over the same nest candidate. `update` takes
// the card under the cursor (null when none) and the current time, and returns
// that card once it has been held for `dwellMs`, else null.
export function createNestDwell(dwellMs = NEST_DWELL_MS) {
  let candidate = null;
  let since = 0;
  return {
    update(card, now) {
      if (card !== candidate) { candidate = card; since = now; }
      return candidate && now - since >= dwellMs ? candidate : null;
    },
    reset() { candidate = null; since = 0; },
  };
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
