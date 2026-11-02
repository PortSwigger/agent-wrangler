// Pure helpers for dragging a session to nest it, move it between parents,
// or reorder nested children, split out of app.js so they're unit-testable
// without a DOM (mirrors task-drag.js). `taskOf` is injected for the same
// reason attach-picker.js takes it.
import { attachCandidates } from './attach-picker.js';

// The sessions `sessionId` may be nested under, by a drop on a target's Nest
// zone or into its child spine, as a Set of ids. Uses the "Attach to…"
// picker's own candidate list, so a drag offers exactly the targets the menu
// does (same task, one level deep, not its current parent). Worked out once
// per drag: the picker's search filters and sorts every session.
export function nestTargetsFor(sessionId, sessions, taskOf) {
  if (!sessionId) return new Set();
  return new Set(attachCandidates(sessionId, sessions, taskOf).map((c) => c.sessionId));
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

// The insert slot for a cursor at (x, y) in a multi-column task body, whose
// top-level units have viewport rects `rects` in reading order (left to
// right, then top to bottom). Returns { index, after }: the unit the drop goes
// beside, and whether after it. Over a unit, its left half is before and its
// right half after. In a gap, the nearest unit in the same visual row decides;
// below every row is after the last unit. null when there are no units.
export function gridSlotAt(rects, x, y) {
  if (!rects.length) return null;
  const side = (i) => ({ index: i, after: x >= (rects[i].left + rects[i].right) / 2 });
  const inside = rects.findIndex((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
  if (inside >= 0) return side(inside);
  let best = -1;
  let bestDist = Infinity;
  rects.forEach((r, i) => {
    if (y < r.top || y >= r.bottom) return;
    const dist = x < r.left ? r.left - x : x >= r.right ? x - r.right : 0;
    if (dist < bestDist) { best = i; bestDist = dist; }
  });
  if (best >= 0) return side(best);
  // Between or past rows: after the last unit that starts above the cursor.
  let last = -1;
  rects.forEach((r, i) => { if (r.top <= y) last = i; });
  return last >= 0 ? { index: last, after: true } : { index: 0, after: false };
}

// A spine draws a parent's whole subtree as flat rows, depth first (see
// workflow.js spineRows). `rows` are those rows in DOM order, each
// { parent, depth, top, bottom }. The index just past row `i`'s subtree: the
// next row no deeper than it, or rows.length when its subtree runs to the end.
export function subtreeEnd(rows, i) {
  let j = i + 1;
  while (j < rows.length && rows[j].depth > rows[i].depth) j++;
  return j;
}

// Where a child of `parent` dropped at viewport-Y `y` goes among that parent's
// other children in `rows`: the index of the row to insert before (rows.length
// appends). Before the first sibling whose midpoint is below the cursor, else
// after the last sibling's whole subtree, so a drop never splits a sibling from
// its own children. null when `parent` has no other children drawn here.
export function childSlotAt(rows, parent, y) {
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].parent !== parent) continue;
    if (y < (rows[i].top + rows[i].bottom) / 2) return i;
    last = i;
  }
  return last < 0 ? null : subtreeEnd(rows, last);
}
