// Pure grid geometry for the Task Grid view: how many cards fit a row, how tall a
// tile grows, and the column-major packing that keeps the board a roughly-square
// grid. Kept dependency-light (only todo.js's tileWeightWithTodos, which itself
// composes on snooze.js) and free of DOM/board state so it can be unit-tested —
// the phase-dependent sorts take an injected `phaseOf(session)` predicate rather
// than reaching for Date.now(), matching how snooze.js keeps `now` explicit.
import { tileWeightWithTodos } from './todo.js';

// The board keeps subdividing into a roughly-square grid as tiles are added
// (3×3 at 9 tiles, 5×4 at 20) rather than scrolling once past a fixed 3×3 — so a
// higher task cap fills the viewport denser instead of running off the bottom.
// `MAX_COLS` bounds how wide it goes; `MAX_FIT_ROWS` is how tall it grows before
// falling back to the fixed-height scrolling layout (only for pathological session
// counts, well past the task cap). Small counts are unaffected: a square target of
// ceil(√total) reproduces the old 3×3 at 9 tiles and 2×2 at 4.
export const MAX_COLS = 6;
export const MAX_FIT_ROWS = 5;
// The tile-SIZING nominal (distinct from MAX_FIT_ROWS, the scroll threshold): the
// on-screen row height a tile's card capacity and the scrolling cell height are
// both figured against, so per-tile spans stay stable regardless of how many rows
// the packed grid ends up using. Deliberately NOT raised alongside MAX_FIT_ROWS —
// doing so would shrink every tile's card budget and cascade span growth.
export const MAX_ONSCREEN_ROWS = 3;
export const MAX_SPAN = 3;         // tallest a tile can grow (rows)
// Per-card vertical stride and the fixed chrome subtracted before dividing, both
// measured off the rendered DOM (not the source box model, which misled an
// earlier estimate). A .session-card is 77px and .task-body adds an 8px gap
// before each subsequent card, so STRIDE = 85px per card. A tile of N cards is
// 85N + 37 tall: .task-head (29) + body padding (16), minus the one 8px gap
// STRIDE over-counts. Unlike an earlier version, this does NOT fold in the
// scrolling path's own -12px cell trim (app.js's cellH computes that
// separately, straight off clientHeight, never reading this constant) — doing
// so here just under-counted the on-screen perRow for no one's benefit, and was
// the reason a handful of absorbed child rows could tip a tile a whole
// mostly-empty row past where it needed to land. Re-measure if the card/tile
// chrome changes in public/styles.css.
export const CARD_STRIDE_PX = 85;
export const TILE_CHROME_PX = 37;
export const MIN_SESSIONS_PER_ROW = 2;
// #grid's own chrome (styles.css): 14px padding top+bottom (28) plus the two
// 12px row-gaps a 3-row `repeat(3, 1fr)` bakes into every track (24). Re-measure
// alongside CARD_STRIDE_PX/TILE_CHROME_PX if #grid's padding/gap change.
export const GRID_CHROME_PX = 52;
// The narrowest a task column stays readable before .card-name / .card-repo /
// .branch-name start ellipsising (they have no min-width — see styles.css — so
// nothing else stops a column shrinking). Judged by eye on one laptop board, NOT
// measured off the box model: 420 collapsed to one column while two were still
// comfortable, 380 felt right. Re-tune the same way if the card chrome changes.
export const MIN_COL_PX = 380;
// #grid's horizontal chrome (styles.css): 14px padding left+right. The 12px column
// gaps are deliberately left out — that makes the cap optimistic by under 10px at
// every breakpoint (6px at 2 columns, 9px at 4), well inside the tolerance of an
// eye-tuned MIN_COL_PX, and folding them in would shift the 2-column breakpoint by
// 12px and mean re-tuning it.
export const GRID_CHROME_X_PX = 28;

// How many session cards comfortably fit (no internal scroll) in one grid row,
// for the current viewport. The basis is the nominal on-screen row height
// (clientHeight, minus #grid's own chrome, / MAX_ONSCREEN_ROWS) — the same
// height the scrolling path locks cells to — so it's conservative when few
// tiles make rows taller than that. Floored, never rounded up: a
// partially-visible card would clip and force the body to scroll, which is
// exactly what "comfortably fits" rules out.
export function sessionsPerRow(gridEl) {
  const rowH = ((gridEl.clientHeight || 0) - GRID_CHROME_PX) / MAX_ONSCREEN_ROWS;
  return Math.max(MIN_SESSIONS_PER_ROW, Math.floor((rowH - TILE_CHROME_PX) / CARD_STRIDE_PX));
}

// How many readable-width columns fit the grid's CURRENT width — the horizontal
// twin of sessionsPerRow, and for the same reason: the packer is otherwise blind to
// the viewport, so 2 columns at 1600px and 2 at 400px look identical to it. Widening
// the terminal (drag-to-resize shrinks #grid, a flex: 1 sibling of #sidebar) used to
// split that narrow grid into two half-width columns and truncate every card; capping
// by width stacks them into one full-width column instead.
export function columnsForWidth(gridEl) {
  const usable = (gridEl.clientWidth || 0) - GRID_CHROME_X_PX;
  return Math.max(1, Math.floor(usable / MIN_COL_PX));
}

// Tile height (in grid rows) derived from how many sessions it holds.
export function rowSpan(sessionCount, perRow) {
  return Math.min(Math.max(Math.ceil(sessionCount / perRow), 1), MAX_SPAN);
}

// Column-major packing: tiles flow down a column, then into the next, in their
// `order` sequence. The Ad-hoc tile is just one of them now, so it packs wherever
// its order position falls. Returns each tile's grid position plus the dimensions
// and whether the board must scroll.
// Starts at a roughly-square column count (ceil(√total)) so the board subdivides
// evenly — 3×3 at 9 tiles, 5×4 at 20 — instead of stacking into few tall columns.
// Retries with one extra column if the greedy result still overflows MAX_FIT_ROWS:
// a large-span tile early in the order can otherwise strand all subsequent tiles
// in the last column while earlier columns sit nearly empty. Only once columns hit
// the cap (`maxCols`, at most MAX_COLS) and rows still overflow does it fall back to
// the scrolling layout.
//
// First-fit, not next-fit: each tile goes into the leftmost column that still
// has room under `target`, not just "the current column, advancing forward
// only." A monotonic ci (next-fit) can permanently strand a column short — e.g.
// spans [2,1,2,2,1,1] (a real 6-task board) used to leave one column at height 2
// of a target 3 (a bare gap with no tile, hence no drop target for
// drag-and-drop) while another column overflowed, even though the total (9)
// divides evenly into three columns of three. First-fit backfills that column
// instead. When no column has room under `target` (every column already full,
// or a single tile's span alone exceeds it), the fallback is the least-loaded
// column — the placement that minimizes the worst overflow.
// `maxCols` caps how wide the board may go — normally MAX_COLS, but app.js passes
// columnsForWidth(#grid) so a narrow grid stacks into fewer (down to one) full-width
// columns instead of splitting into unreadably narrow ones.
export function computeLayout(tiles, maxCols = MAX_COLS) {
  const total = tiles.reduce((a, t) => a + t.span, 0);
  const maxSpan = Math.max(1, ...tiles.map((t) => t.span));
  const pack = (cols) => {
    const target = Math.max(Math.ceil(total / cols), maxSpan);
    const heights = new Array(cols).fill(0);
    const placed = [];
    for (const t of tiles) {
      let ci = heights.findIndex((h) => h + t.span <= target);
      if (ci === -1) ci = heights.indexOf(Math.min(...heights));
      placed.push({ ...t, col: ci, rowStart: heights[ci] });
      heights[ci] += t.span;
    }
    return { placed, cols, heights, rows: Math.max(...heights, 1) };
  };
  // Seed with the fewest columns that keep tiles a comfortable height
  // (≤ MAX_ONSCREEN_ROWS) so a small board uses big panels instead of prematurely
  // splitting into a 3rd column — 5–6 tiles land as 2 wide columns, not 3; the square
  // count (ceil√total) keeps big boards subdivided. They cross at 9 (3×3).
  // Don't delete the `Math.max(2, …)` floor to reach one column — it is the width cap
  // that does that, so a WIDE board still can't collapse into one tall column.
  const squareCols = Math.ceil(Math.sqrt(total));
  const cap = Math.max(1, Math.min(MAX_COLS, maxCols));
  const seed = Math.min(squareCols, Math.max(2, Math.ceil(total / MAX_ONSCREEN_ROWS)));
  let best;
  for (let cols = Math.min(cap, Math.max(1, seed)); ; cols++) {
    best = pack(cols);
    if (best.rows <= MAX_FIT_ROWS || cols >= cap) break;
  }
  // The square starting count can over-provision columns for a few dense tiles
  // (spans [2,1,3] pack into two columns of three, leaving a third empty — a
  // tile-less gap with no drop target). First-fit always leaves the empties
  // rightmost, so collapse to the columns actually used, as long as the denser
  // repack still fits; never below one column.
  while (best.cols > 1) {
    const used = best.heights.filter((h) => h > 0).length;
    if (used >= best.cols) break;
    const shrunk = pack(used);
    if (shrunk.rows > MAX_FIT_ROWS) break;
    best = shrunk;
  }
  return { placed: best.placed, cols: best.cols, rows: best.rows, scroll: best.rows > MAX_FIT_ROWS };
}

// Preview (and commit) a two-tile drag swap without re-running computeLayout on
// the whole board: only the one or two columns that actually hold `draggedId`/
// `targetId` are restacked; every other column's placement passes through
// untouched. Re-running the packer on the whole reordered array (the original
// approach) reflows EVERYTHING from the new order, and on a board near/at
// capacity that can cascade the dragged tile's placeholder into some unrelated
// third column, or overflow a column that was never touched by the drag at all
// — confirmed against a real 6-task board (spans [2,1,2,2,1,2,1], swapping two
// tiles of different spans across columns landed the placeholder in a THIRD
// column and overflowed a column neither tile was ever in).
// The two tiles trade identities at their own LIST position within their
// column (not pixel position): same column ⇒ they simply swap places in that
// column's stack; different columns ⇒ each column gains the other's tile in
// exactly the slot its own tile held, then restacks locally from row 0. If
// that local restack needs more than MAX_FIT_ROWS, only THAT column overflows
// — a column with nothing to do with the swap can never be affected.
// `draggedId`'s new slot renders as a placeholder (matching the existing
// swap-preview convention); `targetId`'s tile moves into `draggedId`'s old
// slot as itself.
export function localSwapPlacement(placed, draggedId, targetId) {
  const byCol = new Map();
  for (const p of placed) {
    if (!byCol.has(p.col)) byCol.set(p.col, []);
    byCol.get(p.col).push(p);
  }
  for (const list of byCol.values()) list.sort((a, b) => a.rowStart - b.rowStart);

  let draggedCol = -1, draggedIdx = -1, targetCol = -1, targetIdx = -1;
  for (const [col, list] of byCol) {
    list.forEach((p, idx) => {
      if (p.id === draggedId) { draggedCol = col; draggedIdx = idx; }
      if (p.id === targetId) { targetCol = col; targetIdx = idx; }
    });
  }
  if (draggedCol === -1 || targetCol === -1) return null;

  const draggedList = byCol.get(draggedCol);
  const targetList = byCol.get(targetCol);
  const draggedEntry = draggedList[draggedIdx];
  const targetEntry = targetList[targetIdx];
  draggedList[draggedIdx] = { ...targetEntry, col: draggedCol };
  targetList[targetIdx] = { kind: 'placeholder', id: draggedEntry.id, span: draggedEntry.span, col: targetCol };

  const result = [];
  for (const [col, list] of byCol) {
    if (col === draggedCol || col === targetCol) {
      let row = 0;
      for (const p of list) { result.push({ ...p, rowStart: row }); row += p.span; }
    } else {
      result.push(...list);
    }
  }
  const rows = Math.max(...result.map((p) => p.rowStart + p.span), 1);
  return { placed: result, rows, scroll: rows > MAX_FIT_ROWS };
}

// Sort a task's live sessions by their position in the stored order list;
// sessions not yet in the list (rank Infinity on both sides) fall back to
// `createdAt` ascending — a stable key that survives a resume — rather than
// whatever raw order the caller's array happened to arrive in. That raw order
// mirrors the server's live/discovered/dormant assembly passes, which can
// reshuffle a session between passes (e.g. a resume moves it from the dormant
// pass into the discovered/fork pass) with no relation to display order, and
// leaked straight through here for any bucket with no explicit drag order —
// chiefly Ad-hoc, which never gets one from plain assignment (see resume-jump).
export function orderSessions(sessions, order) {
  const rank = new Map((order || []).map((sid, i) => [sid, i]));
  return [...sessions].sort((a, b) => {
    const ra = rank.has(a.sessionId) ? rank.get(a.sessionId) : Infinity;
    const rb = rank.has(b.sessionId) ? rank.get(b.sessionId) : Infinity;
    if (ra !== rb) return ra - rb;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

// The per-task "sort by last activity" alternative to orderSessions: most-recently-
// active first (the `lastActivity` value the card already shows), ties broken by
// createdAt descending — a stable, resume-proof key. Drag-reorder is suppressed while
// this is on, so there's no stored order to consult.
export function sortByLastActivity(sessions) {
  return [...sessions].sort((a, b) =>
    (b.lastActivity || 0) - (a.lastActivity || 0)
    || (b.createdAt || 0) - (a.createdAt || 0));
}

// Asleep sessions sink below active ones; among themselves, soonest wake first.
// Active order is preserved (stable sort on a 0/1 key). `phaseOf` is injected so
// this stays pure (app.js passes its Date.now()-backed phaseOf).
export function sortAsleepLast(sessions, phaseOf) {
  return [...sessions].sort((a, b) => {
    const aa = phaseOf(a) === 'asleep' ? 1 : 0;
    const ab = phaseOf(b) === 'asleep' ? 1 : 0;
    if (aa !== ab) return aa - ab;
    if (aa && ab) return (a.snooze.until || 0) - (b.snooze.until || 0);
    return 0;
  });
}

// The board's visible tiles: the display order minus any minimised id. The board
// must always show at least one tile, so if the caller has (somehow) minimised
// every id, fall back to the full order rather than rendering an empty grid — the
// same self-heal spirit as pruneMinimised. Order is preserved; ids are opaque
// strings (a task id or app.js's ADHOC_ID sentinel — layout.js never inspects them).
export function visibleTileIds(orderIds, minimisedSet) {
  const visible = orderIds.filter((id) => !minimisedSet.has(id));
  return visible.length ? visible : [...orderIds];
}

// Drop any minimised id that no longer names a live tile (task deleted / archived
// away), mirroring the old focusedTaskId self-heal. Returns a fresh Set — callers
// compare/persist it, so never mutate the input.
export function pruneMinimised(minimisedSet, validIds) {
  return new Set([...minimisedSet].filter((id) => validIds.has(id)));
}

// One-shot migration of the legacy single-value focus (aw.focusedTaskId) into the
// new minimised set: a focused task IS "every other tile minimised". An unknown or
// absent focused id yields the empty set — i.e. the full board, matching the old
// invalid-focus fallback. Returns a Set of the OTHER ids.
export function expandFocusToMinimised(orderIds, focusedId) {
  if (!focusedId || !orderIds.includes(focusedId)) return new Set();
  return new Set(orderIds.filter((id) => id !== focusedId));
}

// Tile row-span: top-level active cards drive it at full weight (never clipped —
// a session rendered as its own card must stay fully visible), while asleep
// rows, todos, and absorbed child-session rows (workflow workers, or any other
// nested spawn — see workflow.js computeAbsorption) are secondary (see snooze.js
// / todo.js) and are capped at one row-equivalent's worth of extra height
// combined. Without the cap, a handful of light rows can tip the ceil() just
// past a row boundary and cost a whole mostly-empty grid row (or hit MAX_SPAN) —
// e.g. 2 active + 2 snoozed + 2 todos was maxing out at 3 rows. Past the cap,
// `.task-body`'s own scroll (styles.css) shows the rest.
// `childRowCount`/`absorbedChildCount` are injected (like `phaseOf`) rather than
// derived here: knowing which sessions are absorbed needs the whole tile's
// session set (computeAbsorption) plus workflow-collapse state, both of which
// app.js already has to hand.
//
// The two counts differ on purpose and must NOT be collapsed into one: a session
// absorbed into a parent's spine never renders as its own full card, whether or
// not that spine is currently shown — so `absorbedChildCount` (structural, always
// the true count) is what's subtracted out of the raw session count to get
// `topLevelActiveCount`, while `childRowCount` (only the rows actually visible —
// 0 for a collapsed workflow box's workers) is what feeds the light secondary
// weight. Conflating them was a real bug: using the collapse-affected count for
// BOTH meant collapsing put those sessions back into `topLevelActiveCount` as if
// they were newly-visible full cards, growing the tile exactly when it should
// shrink (verified against a live board).
//
// `workflowBoxCount` is a THIRD, distinct secondary term: a workflow run's own
// box chrome (border, padding, "Workflow" header — see todo.js's
// WORKFLOW_BOX_CHROME_PX), never counted per child row. Unlike
// `childRowCount`, collapsing a workflow's spine does NOT drop this to 0 — the
// box, border and header stay on screen either way (only the spine's rows
// disappear); only removing the workflow run itself (or it having none at all)
// should change it.
export function tileSpan(
  sessions, perRow, todoCount = 0, phaseOf, childRowCount = 0, absorbedChildCount = childRowCount, workflowBoxCount = 0,
) {
  const snoozedCount = sessions.filter((s) => phaseOf(s) === 'asleep').length;
  const topLevelActiveCount = sessions.length - snoozedCount - absorbedChildCount;
  const totalWeight = tileWeightWithTodos({
    activeCount: topLevelActiveCount, snoozedCount, cardStride: CARD_STRIDE_PX, todoCount, childRowCount, workflowBoxCount,
  });
  const secondaryWeight = Math.min(totalWeight - topLevelActiveCount, perRow);
  return rowSpan(topLevelActiveCount + secondaryWeight, perRow);
}
