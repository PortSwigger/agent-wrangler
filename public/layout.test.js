import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_COLS, MAX_ONSCREEN_ROWS, MAX_FIT_ROWS, MAX_SPAN, CARD_STRIDE_PX, TILE_CHROME_PX, GRID_CHROME_PX, MIN_SESSIONS_PER_ROW,
  sessionsPerRow, rowSpan, computeLayout, orderSessions, sortByLastActivity, sortAsleepLast, tileSpan,
  localSwapPlacement, visibleTileIds, pruneMinimised, expandFocusToMinimised,
} from './layout.js';
import { tileWeight } from './snooze.js';

// A stand-in for app.js's Date.now()-backed phaseOf: a session is asleep iff we
// tag it so, keeping these tests time-independent.
const phaseOf = (s) => (s.asleep ? 'asleep' : 'awake');
const sess = (id, extra = {}) => ({ sessionId: id, snooze: {}, ...extra });
const ADHOC = '__adhoc__';

test('constants are exported positive numbers', () => {
  for (const c of [MAX_COLS, MAX_ONSCREEN_ROWS, MAX_FIT_ROWS, MAX_SPAN, CARD_STRIDE_PX, TILE_CHROME_PX, GRID_CHROME_PX, MIN_SESSIONS_PER_ROW]) {
    assert.equal(typeof c, 'number');
    assert.ok(c > 0);
  }
});

test('sessionsPerRow: floors to the cards that fit, never below the minimum', () => {
  // A row tall enough for ~4 cards after chrome, plus the grid's own chrome
  // (padding + row-gaps) so the intended 4-card slack survives GRID_CHROME_PX
  // being subtracted first.
  const tall = { clientHeight: (4 * CARD_STRIDE_PX + TILE_CHROME_PX) * MAX_ONSCREEN_ROWS + GRID_CHROME_PX };
  assert.equal(sessionsPerRow(tall), 4);
  // A partial extra card is floored away, not rounded up.
  const partial = { clientHeight: (4 * CARD_STRIDE_PX + Math.floor(CARD_STRIDE_PX / 2) + TILE_CHROME_PX) * MAX_ONSCREEN_ROWS + GRID_CHROME_PX };
  assert.equal(sessionsPerRow(partial), 4);
  // A tiny / zero-height viewport clamps up to the minimum.
  assert.equal(sessionsPerRow({ clientHeight: 0 }), MIN_SESSIONS_PER_ROW);
});

// GRID_CHROME_PX regression: #grid's own 14px padding + two 12px row-gaps (52px
// total for the 3 nominal rows) used to be dropped entirely, so
// clientHeight/MAX_ONSCREEN_ROWS overestimated the real 1fr track height —
// harmless at low row/tile counts where slack absorbs it, but confirmed
// against a live board (§ the test below) to overcount perRow by a whole card
// once tiles pack densely (a 3×3 board). Never overestimate: the "raw"
// (unfixed) formula must always report perRow >= the fixed one.
test('sessionsPerRow: never overestimates capacity relative to the grid\'s real chrome', () => {
  const rawFormula = (clientHeight) => Math.max(MIN_SESSIONS_PER_ROW, Math.floor(((clientHeight / MAX_ONSCREEN_ROWS) - TILE_CHROME_PX) / CARD_STRIDE_PX));
  for (const clientHeight of [600, 900, 1107, 1152, 1500]) {
    assert.ok(sessionsPerRow({ clientHeight }) <= rawFormula(clientHeight));
  }
});

test('rowSpan: ceil(count/perRow), clamped to [1, MAX_SPAN]', () => {
  assert.equal(rowSpan(0, 2), 1);          // never zero
  assert.equal(rowSpan(1, 2), 1);
  assert.equal(rowSpan(3, 2), 2);          // ceil(3/2)
  assert.equal(rowSpan(100, 2), MAX_SPAN); // clamped tall
});

test('computeLayout: packs single-span tiles column-major, no scroll when it fits', () => {
  const tiles = [1, 2, 3].map((n) => ({ id: `t${n}`, span: 1 }));
  const { placed, cols, rows, scroll } = computeLayout(tiles);
  assert.equal(scroll, false);
  assert.ok(cols >= 1 && cols <= MAX_COLS);
  assert.equal(rows, Math.max(...columnHeights(placed, cols)));
  // Every tile is placed exactly once, each within bounds.
  assert.equal(placed.length, tiles.length);
  for (const p of placed) {
    assert.ok(p.col >= 0 && p.col < cols);
    assert.ok(p.rowStart >= 0);
  }
});

test('computeLayout: caps at MAX_COLS and reports scroll when it overflows', () => {
  // Enough full-height tiles that even MAX_COLS columns overflow MAX_FIT_ROWS.
  const tiles = Array.from({ length: MAX_COLS * MAX_FIT_ROWS + 3 }, (_, i) => ({ id: `t${i}`, span: MAX_SPAN }));
  const { cols, rows, scroll } = computeLayout(tiles);
  assert.equal(cols, MAX_COLS);
  assert.ok(rows > MAX_FIT_ROWS);
  assert.equal(scroll, true);
});

// The point of the change: a full board of ordinary single-span tiles keeps
// subdividing into a roughly-square grid on one screen instead of scrolling. 9
// tiles reproduce the old 3×3; 20 (19 tasks + Ad-hoc) land as a ~5×4 that fits.
test('computeLayout: single-span tiles pack square and fit on screen up to the cap', () => {
  for (const [n, wantCols] of [[4, 2], [9, 3], [16, 4], [20, 5]]) {
    const tiles = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, span: 1 }));
    const { cols, rows, scroll } = computeLayout(tiles);
    assert.equal(scroll, false, `${n} tiles should fit without scroll`);
    assert.equal(cols, wantCols, `${n} tiles → ${wantCols} cols`);
    assert.ok(rows <= MAX_FIT_ROWS);
    assert.ok(cols * rows >= n); // every tile has a cell
  }
});

// A small board should use the fewest columns that keep tiles a comfortable
// height rather than prematurely splitting into a 3rd column: 5–6 single-span
// tiles want 2 wide columns, not 3. The jump to 3 is at 7 (where 2 columns would
// exceed MAX_ONSCREEN_ROWS). 2–3 tiles must NOT collapse into a single column.
test('computeLayout: 5–6 single-span tiles use 2 columns; 7+ go to 3', () => {
  for (const [n, wantCols] of [[2, 2], [3, 2], [5, 2], [6, 2], [7, 3], [8, 3]]) {
    const tiles = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, span: 1 }));
    const { cols, scroll } = computeLayout(tiles);
    assert.equal(scroll, false, `${n} tiles should fit without scroll`);
    assert.equal(cols, wantCols, `${n} tiles → ${wantCols} cols`);
  }
});

test('computeLayout: a big early tile does not strand later tiles in the last column', () => {
  // One tall tile then several short ones: the retry-with-more-columns keeps the
  // shorts from all piling into the final column.
  const tiles = [{ id: 'big', span: 3 }, ...Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, span: 1 }))];
  const { placed, cols } = computeLayout(tiles);
  const used = new Set(placed.map((p) => p.col));
  assert.ok(used.size > 1 || cols === 1);
});

// Regression: a real 6-task board with spans [2,1,2,2,1,1] (total 9, divides
// evenly into three columns of three) used to leave one column stranded at
// height 2 — a bare, tile-less gap with no drop target for drag-and-drop —
// while a later column overflowed past MAX_ONSCREEN_ROWS, because next-fit's
// column pointer only ever advanced and could never backfill the gap it left
// behind. First-fit finds the even [3,3,3] packing.
test('computeLayout: first-fit backfills an earlier column instead of stranding it', () => {
  const tiles = [
    { id: 'a', span: 2 }, { id: 'b', span: 1 }, { id: 'c', span: 2 },
    { id: 'd', span: 2 }, { id: 'e', span: 1 }, { id: 'f', span: 1 },
  ];
  const { placed, cols, rows, scroll } = computeLayout(tiles);
  assert.equal(cols, 3);
  assert.equal(rows, 3);
  assert.equal(scroll, false);
  assert.deepEqual(columnHeights(placed, cols), [3, 3, 3]);
});

// Regression: a real board of 3 tiles with spans [2,1,3] (total 6). ceil(√6)=3
// is the starting column count, but the tiles pack densely into two columns of
// three, so the third column comes out empty — a full-height, tile-less gap
// that nothing can be dropped onto. computeLayout used to declare that dead
// column anyway (it only ever GROWS the column count for overflow, never shrinks
// it); it must collapse to the columns actually used.
test('computeLayout: collapses a column left empty by the square starting count', () => {
  const tiles = [{ id: 'a', span: 2 }, { id: 'b', span: 1 }, { id: 'c', span: 3 }];
  const { placed, cols, rows, scroll } = computeLayout(tiles);
  assert.equal(scroll, false);
  assert.equal(cols, 2);
  assert.deepEqual(columnHeights(placed, cols), [3, 3]);
  // No declared column is left without a tile.
  for (const h of columnHeights(placed, cols)) assert.ok(h > 0);
});

// localSwapPlacement only ever consumes an already-`placed` array — it doesn't
// care how many columns computeLayout chose or why, so these tests hand-craft
// the fixture directly rather than deriving it from computeLayout. That keeps
// them decoupled from computeLayout's own column-count heuristic (which the
// roughly-square-grid change made total-dependent — ceil(√total) now, not
// ceil(total/MAX_ONSCREEN_ROWS)), so a future change there can't silently
// change which columns these tiles land in and break an unrelated test.

// Regression: on a real 3-h2-top / 3-h1-bottom board, dragging the top-left h2
// tile onto the bottom-middle h1 tile used to re-run computeLayout on the
// whole reordered board — which cascaded: the placeholder landed in the THIRD
// column (top-right's), not the one being hovered, and that column silently
// overflowed even though neither dragged nor target tile was ever in it.
// localSwapPlacement must keep the swap confined to the two columns the
// dragged/target tile actually live in.
test('localSwapPlacement: a cross-column, mixed-span swap never touches a third column', () => {
  const canonical = [
    { id: 'topLeft', span: 2, col: 0, rowStart: 0 }, { id: 'bottomLeft', span: 1, col: 0, rowStart: 2 },
    { id: 'topMid', span: 2, col: 1, rowStart: 0 }, { id: 'bottomMid', span: 1, col: 1, rowStart: 2 },
    { id: 'topRight', span: 2, col: 2, rowStart: 0 }, { id: 'adhoc', span: 1, col: 2, rowStart: 2 },
  ];
  const topRightBefore = canonical.find((p) => p.id === 'topRight');
  const adhocBefore = canonical.find((p) => p.id === 'adhoc');

  const { placed, rows, scroll } = localSwapPlacement(canonical, 'topLeft', 'bottomMid');

  // The third column (topRight/adhoc) is untouched, byte-for-byte.
  assert.deepEqual(placed.find((p) => p.id === 'topRight'), topRightBefore);
  assert.deepEqual(placed.find((p) => p.id === 'adhoc'), adhocBefore);

  // The placeholder (standing in for the dragged topLeft) lands in bottomMid's
  // OWN column, not somewhere else.
  const ph = placed.find((p) => p.kind === 'placeholder');
  const bottomMidCol = canonical.find((p) => p.id === 'bottomMid').col;
  assert.equal(ph.col, bottomMidCol);
  // That column now holds a 2-row tile where a 1-row one used to be, so it
  // grows by exactly one row — the only column allowed to change height.
  // Still well under MAX_FIT_ROWS (5), so no scroll.
  assert.equal(rows, 4);
  assert.equal(scroll, false);
});

test('localSwapPlacement: same-column swap only reorders that column', () => {
  const canonical = [
    { id: 'topLeft', span: 2, col: 0, rowStart: 0 }, { id: 'bottomLeft', span: 1, col: 0, rowStart: 2 },
    { id: 'topMid', span: 2, col: 1, rowStart: 0 }, { id: 'bottomMid', span: 1, col: 1, rowStart: 2 },
  ];
  const topMidBefore = canonical.find((p) => p.id === 'topMid');
  const bottomMidBefore = canonical.find((p) => p.id === 'bottomMid');

  const { placed, rows, scroll } = localSwapPlacement(canonical, 'topLeft', 'bottomLeft');

  assert.deepEqual(placed.find((p) => p.id === 'topMid'), topMidBefore);
  assert.deepEqual(placed.find((p) => p.id === 'bottomMid'), bottomMidBefore);
  // bottomLeft (span 1) now sits first (row 0); the placeholder (span 2, for
  // topLeft) stacks below it.
  const bl = placed.find((p) => p.id === 'bottomLeft');
  const ph = placed.find((p) => p.kind === 'placeholder');
  assert.equal(bl.rowStart, 0);
  assert.equal(ph.rowStart, 1);
  assert.equal(rows, 3);
  assert.equal(scroll, false);
});

// The "drop it back where it was" case: swapping a tile with itself-in-effect
// (dragged === target) isn't a valid input — callers must guard that before
// calling, same as commitTaskSwap/renderGrid already do.
test('localSwapPlacement: unknown ids return null rather than throwing', () => {
  const tiles = [{ id: 'a', span: 1 }, { id: 'b', span: 1 }];
  const { placed: canonical } = computeLayout(tiles);
  assert.equal(localSwapPlacement(canonical, 'a', 'ghost'), null);
});

test('orderSessions: sorts by the stored order; unlisted ids sink after by createdAt', () => {
  const sessions = [sess('a'), sess('b'), sess('c'), sess('d')];
  const ordered = orderSessions(sessions, ['c', 'a']);
  assert.deepEqual(ordered.map((s) => s.sessionId), ['c', 'a', 'b', 'd']);
});

test('orderSessions: empty/missing order falls back to createdAt ascending (stable, no createdAt = unchanged)', () => {
  const sessions = [sess('a'), sess('b')];
  assert.deepEqual(orderSessions(sessions, []).map((s) => s.sessionId), ['a', 'b']);
  assert.deepEqual(orderSessions(sessions, null).map((s) => s.sessionId), ['a', 'b']);
});

// The bug this guards against: a session with no explicit rank (e.g. the
// Ad-hoc bucket, which never gets one from plain assignment) must not have its
// display position driven by whatever raw order the caller's array arrives
// in — that order mirrors the server's live/discovered/dormant assembly
// passes and can reshuffle a session between passes (e.g. a resume) with no
// relation to where it was displayed. createdAt is stable across a resume, so
// ordering unranked sessions by it keeps a dormant session in place when it
// wakes, regardless of which pass now represents it.
test('orderSessions: unranked sessions sort by createdAt, not arrival order', () => {
  const sessions = [
    sess('newest', { createdAt: 300 }),
    sess('oldest', { createdAt: 100 }),
    sess('middle', { createdAt: 200 }),
  ];
  assert.deepEqual(orderSessions(sessions, null).map((s) => s.sessionId), ['oldest', 'middle', 'newest']);
});

test('orderSessions: a partial stored order still falls back to createdAt among the unranked remainder', () => {
  const sessions = [sess('ranked', { createdAt: 999 }), sess('newer', { createdAt: 300 }), sess('older', { createdAt: 100 })];
  const ordered = orderSessions(sessions, ['ranked']);
  assert.deepEqual(ordered.map((s) => s.sessionId), ['ranked', 'older', 'newer']);
});

test('sortByLastActivity: most-recently-active first, ties broken by createdAt descending', () => {
  const sessions = [
    sess('old', { lastActivity: 100, createdAt: 1 }),
    sess('new', { lastActivity: 300, createdAt: 1 }),
    sess('mid', { lastActivity: 200, createdAt: 1 }),
  ];
  assert.deepEqual(sortByLastActivity(sessions).map((s) => s.sessionId), ['new', 'mid', 'old']);
  // Same lastActivity → newer createdAt wins; missing values sort last.
  const tie = [sess('older', { lastActivity: 5, createdAt: 10 }), sess('newer', { lastActivity: 5, createdAt: 20 }), sess('none')];
  assert.deepEqual(sortByLastActivity(tie).map((s) => s.sessionId), ['newer', 'older', 'none']);
});

test('sortAsleepLast: asleep sink below awake; among asleep, soonest wake first', () => {
  const sessions = [
    sess('awake1'),
    sess('sleepLate', { asleep: true, snooze: { until: 200 } }),
    sess('awake2'),
    sess('sleepSoon', { asleep: true, snooze: { until: 100 } }),
  ];
  const out = sortAsleepLast(sessions, phaseOf).map((s) => s.sessionId);
  assert.deepEqual(out, ['awake1', 'awake2', 'sleepSoon', 'sleepLate']);
});

test('tileSpan: composes tileWeight → rowSpan for an all-awake tile', () => {
  const sessions = [sess('a'), sess('b'), sess('c')];
  const perRow = 2;
  const weight = tileWeight({ activeCount: 3, snoozedCount: 0, cardStride: CARD_STRIDE_PX });
  assert.equal(tileSpan(sessions, perRow, 0, phaseOf), rowSpan(weight, perRow));
});

test('tileSpan: asleep cards count fractionally, so they weigh less than awake ones', () => {
  const perRow = 2;
  const awake = [sess('a'), sess('b'), sess('c')];
  const withSleep = [sess('a'), sess('b'), sess('c', { asleep: true, snooze: { until: 1 } })];
  const allAwakeWeight = tileWeight({ activeCount: 3, snoozedCount: 0, cardStride: CARD_STRIDE_PX });
  const mixedWeight = tileWeight({ activeCount: 2, snoozedCount: 1, cardStride: CARD_STRIDE_PX });
  assert.ok(mixedWeight < allAwakeWeight);
  assert.equal(tileSpan(awake, perRow, 0, phaseOf), rowSpan(allAwakeWeight, perRow));
  assert.equal(tileSpan(withSleep, perRow, 0, phaseOf), rowSpan(mixedWeight, perRow));
});

test('visibleTileIds: returns order minus the minimised set, preserving order', () => {
  const order = ['a', 'b', 'c', ADHOC];
  assert.deepEqual(visibleTileIds(order, new Set(['b'])), ['a', 'c', ADHOC]);
});

test('visibleTileIds: empty minimised set returns the whole order unchanged', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(visibleTileIds(order, new Set()), ['a', 'b', 'c']);
});

test('visibleTileIds: never returns empty — if every id is minimised, falls back to the full order', () => {
  const order = ['a', 'b'];
  assert.deepEqual(visibleTileIds(order, new Set(['a', 'b'])), ['a', 'b']);
});

test('pruneMinimised: keeps only ids still present in the valid set', () => {
  const pruned = pruneMinimised(new Set(['a', 'gone', ADHOC]), new Set(['a', 'b', ADHOC]));
  assert.deepEqual([...pruned].sort(), ['a', ADHOC].sort());
});

test('pruneMinimised: returns a new Set, never mutates its input', () => {
  const input = new Set(['a', 'gone']);
  const pruned = pruneMinimised(input, new Set(['a']));
  assert.deepEqual([...input].sort(), ['a', 'gone'].sort()); // input untouched
  assert.deepEqual([...pruned], ['a']);
});

test('expandFocusToMinimised: a valid focused id maps to "all other ids minimised"', () => {
  const out = expandFocusToMinimised(['a', 'b', 'c'], 'b');
  assert.deepEqual([...out].sort(), ['a', 'c'].sort());
});

test('expandFocusToMinimised: an unknown / null focused id maps to the empty set (full board)', () => {
  assert.deepEqual([...expandFocusToMinimised(['a', 'b'], 'gone')], []);
  assert.deepEqual([...expandFocusToMinimised(['a', 'b'], null)], []);
});

// Helper: reconstruct per-column heights from a placement.
function columnHeights(placed, cols) {
  const h = new Array(cols).fill(0);
  for (const p of placed) h[p.col] = Math.max(h[p.col], p.rowStart + p.span);
  return h;
}

// The bug this guards against: light secondary content (asleep sessions, todos)
// used to add its full fractional weight straight into the ceil() that decides
// row-span, so a handful of it could tip a tile just past a row boundary and
// cost a whole extra (mostly-empty) grid row. 2 active + 2 snoozed + 2 todos at
// perRow=2 used to hit the MAX_SPAN cap (3 rows) even though 2 active alone only
// needs 1 — the secondary content should cost at most one extra row, not two.
test('tileSpan: 2 active + 2 snoozed + 2 todos does not max out at MAX_SPAN', () => {
  const perRow = 2;
  const sessions = [
    sess('a1'), sess('a2'),
    sess('s1', { asleep: true, snooze: { until: 1 } }),
    sess('s2', { asleep: true, snooze: { until: 1 } }),
  ];
  assert.equal(tileSpan(sessions, perRow, 2, phaseOf), 2);
});

test('tileSpan: secondary (asleep + todo) weight is capped at one row-equivalent', () => {
  const perRow = 2;
  const activeOnly = [sess('a1'), sess('a2')];
  // Piling on far more secondary content than one row's worth still only costs
  // one extra row over the active-only tile — scroll handles the rest.
  const heavySleep = [
    ...activeOnly,
    ...Array.from({ length: 20 }, (_, i) => sess(`s${i}`, { asleep: true, snooze: { until: 1 } })),
  ];
  const activeSpan = tileSpan(activeOnly, perRow, 0, phaseOf);
  const heavySpan = tileSpan(heavySleep, perRow, 0, phaseOf);
  assert.equal(activeSpan, 1);
  assert.equal(heavySpan, 2);
});

// childRowCount (a workflow's absorbed workers, or any other nested child —
// computed in app.js via workflow.js's computeAbsorption, since deciding what's
// absorbed needs the whole tile's session set) weighs like a todo/snoozed row,
// not a full active card — a task with one orchestrator + several workers should
// read as roughly "1 card plus a light spine", not "N full cards".
test('tileSpan: child-session rows weigh light, not full active-card weight', () => {
  const perRow = 2;
  const soloOrch = [sess('orch')];
  assert.equal(tileSpan(soloOrch, perRow, 0, phaseOf, 0), 1);
  // 2 children add only a fraction of a row, same order of magnitude as 2 todos.
  assert.equal(tileSpan(soloOrch, perRow, 0, phaseOf, 2), 1);
});

test('tileSpan: child-row weight is capped at one row-equivalent, however many pile on', () => {
  const perRow = 2;
  const soloOrch = [sess('orch')];
  const fewChildren = tileSpan(soloOrch, perRow, 0, phaseOf, 2);
  const manyChildren = tileSpan(soloOrch, perRow, 0, phaseOf, 20);
  assert.equal(fewChildren, manyChildren); // both clamp to the same one-row cap
});

// The bug a live-board check caught: collapsing a workflow box hides its
// workers' rows (childRowCount drops to 0) but the workers themselves are still
// present in `sessions` — they never became full cards just because their spine
// is hidden. Using childRowCount alone (its default) to also derive
// topLevelActiveCount put them BACK into the full-weight active count on
// collapse, growing the tile exactly when it should shrink (2 -> 3 here).
test('tileSpan: BUG — deriving topLevelActiveCount from childRowCount alone re-inflates on collapse', () => {
  const perRow = 2;
  const workflowTile = [sess('orch'), sess('w1'), sess('w2'), sess('w3'), sess('w4')];
  const expanded = tileSpan(workflowTile, perRow, 0, phaseOf, 4); // no absorbedChildCount arg: defaults to childRowCount
  const collapsedBuggy = tileSpan(workflowTile, perRow, 0, phaseOf, 0); // same bug: defaults to 0
  assert.equal(expanded, 2);
  assert.equal(collapsedBuggy, 3); // reproduces the regression: collapse GREW the tile
});

// The fix: pass the structural absorbedChildCount (4, unchanged by collapse)
// alongside the visible childRowCount (0 when collapsed) — the workers stay
// excluded from topLevelActiveCount either way, and only the light secondary
// weight they contribute drops to zero, so collapsing only ever shrinks.
test('tileSpan: collapsing a workflow box (absorbedChildCount passed) shrinks the tile, never grows it', () => {
  const perRow = 2;
  const workflowTile = [sess('orch'), sess('w1'), sess('w2'), sess('w3'), sess('w4')];
  const expanded = tileSpan(workflowTile, perRow, 0, phaseOf, 4, 4);
  const collapsed = tileSpan(workflowTile, perRow, 0, phaseOf, 0, 4);
  assert.equal(expanded, 2);
  assert.equal(collapsed, 1);
  assert.ok(collapsed <= expanded);
});

// A workflow box's own chrome (border, padding, "Workflow" header) is charged
// once per top-level workflow run, distinct from childRowCount — it's present
// even for a "solo" run with no workers yet (workflowBoxHtml still wraps a box
// around a childless orchestrator).
test('tileSpan: a solo workflow run (no workers) still costs its box chrome', () => {
  const perRow = 2;
  const plain = [sess('orch')];
  const solo = tileSpan(plain, perRow, 0, phaseOf, 0, 0, 1);
  const bare = tileSpan(plain, perRow, 0, phaseOf, 0, 0, 0);
  assert.ok(solo >= bare);
});

// Collapsing a workflow's spine hides its worker rows (childRowCount -> 0) but
// the box itself — border, padding, header — never disappears (see
// toggleWorkflowCollapse in app.js), so workflowBoxCount must NOT drop with it.
test('tileSpan: collapsing a workflow keeps paying for its box chrome, unlike its child rows', () => {
  const perRow = 2;
  const workflowTile = [sess('orch'), sess('w1'), sess('w2'), sess('w3'), sess('w4')];
  const expanded = tileSpan(workflowTile, perRow, 0, phaseOf, 4, 4, 1);
  const collapsed = tileSpan(workflowTile, perRow, 0, phaseOf, 0, 4, 1); // childRowCount 0, workflowBoxCount unchanged
  const collapsedNoBox = tileSpan(workflowTile, perRow, 0, phaseOf, 0, 4, 0); // what it'd be if the box chrome wrongly dropped too
  assert.ok(collapsed >= collapsedNoBox);
});

// A live-board regression, updated for the GRID_CHROME_PX fix: at a real
// 1152px-tall grid, perRow is 3, not 4 — the previous "4" came from
// clientHeight/MAX_ONSCREEN_ROWS ignoring #grid's own 52px of padding/row-gap
// chrome (see GRID_CHROME_PX), which overcounted how many cards actually fit
// a real on-screen row (confirmed by measuring the live board: 4 cards need
// more vertical space than a real single-row tile has, 3 do not). At the
// corrected perRow=3, the 3-row absorbed child spine now genuinely needs the
// tile's 3rd row rather than being (wrongly) absorbed into 2.
test('tileSpan: perRow reflects the grid\'s real per-row budget, not an inflated one', () => {
  const clientHeight = 1152; // matches a real live-board grid height
  const perRow = sessionsPerRow({ clientHeight });
  assert.equal(perRow, 3); // was 4 before GRID_CHROME_PX was subtracted
  const sessions = [sess('parent'), sess('a'), sess('b'), sess('c'), sess('d'), sess('w1'), sess('w2'), sess('w3')];
  assert.equal(tileSpan(sessions, perRow, 0, phaseOf, 3, 3), 3);
});

