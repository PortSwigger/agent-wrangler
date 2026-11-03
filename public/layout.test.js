import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_COLS, MAX_FIT_ROWS, MAX_SPAN, MIN_COL_PX, GRID_CHROME_X_PX,
  columnsForWidth, computeLayout, orderSessions, sortByLastActivity, sortAsleepLast, tileWeightWithBody,
  CHILD_STRIDE_PX, WORKFLOW_BOX_CHROME_PX, SUBAGENT_ROW_STRIDE_PX, SUBAGENT_ZONE_BASE_PX,
  localSwapPlacement, visibleTileIds, pruneMinimised, expandFocusToMinimised,
} from './layout.js';
import { tileWeight, SNOOZE_DIVIDER_PX, SNOOZE_STRIDE_PX } from './snooze.js';

const phaseOf = (s) => (s.asleep ? 'asleep' : 'awake');
const sess = (id, extra = {}) => ({ sessionId: id, snooze: {}, ...extra });
const ADHOC = '__adhoc__';

function columnHeights(placed, cols) {
  const h = new Array(cols).fill(0);
  for (const p of placed) h[p.col] = Math.max(h[p.col], p.rowStart + p.span);
  return h;
}

test('columnsForWidth: floors to the readable-width columns that fit, never below one', () => {
  // Room for exactly 3 columns of MIN_COL_PX, plus the grid's own horizontal chrome.
  const wide = { clientWidth: 3 * MIN_COL_PX + GRID_CHROME_X_PX };
  assert.equal(columnsForWidth(wide), 3);
  // A partial extra column is floored away, not rounded up.
  const partial = { clientWidth: 3 * MIN_COL_PX + Math.floor(MIN_COL_PX / 2) + GRID_CHROME_X_PX };
  assert.equal(columnsForWidth(partial), 3);
  // A narrow / zero-width grid still yields one column, never zero.
  assert.equal(columnsForWidth({ clientWidth: 0 }), 1);
  assert.equal(columnsForWidth({ clientWidth: MIN_COL_PX - 1 }), 1);
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

test('computeLayout: 5–6 single-span tiles use 2 columns; 7+ go to 3', () => {
  for (const [n, wantCols] of [[2, 2], [3, 2], [5, 2], [6, 2], [7, 3], [8, 3]]) {
    const tiles = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, span: 1 }));
    const { cols, scroll } = computeLayout(tiles);
    assert.equal(scroll, false, `${n} tiles should fit without scroll`);
    assert.equal(cols, wantCols, `${n} tiles → ${wantCols} cols`);
  }
});

test('computeLayout: a maxCols cap of 1 stacks every tile into one column', () => {
  const tiles = [1, 2, 3].map((n) => ({ id: `t${n}`, span: 1 }));
  const { placed, cols } = computeLayout(tiles, 1);
  assert.equal(cols, 1);
  assert.deepEqual(placed.map((p) => p.col), [0, 0, 0]);
  assert.deepEqual(placed.map((p) => p.rowStart), [0, 1, 2]);
});

test('computeLayout: a capped board that no longer fits reports scroll', () => {
  const tiles = Array.from({ length: MAX_FIT_ROWS + 2 }, (_, i) => ({ id: `t${i}`, span: 1 }));
  const { cols, rows, scroll } = computeLayout(tiles, 1);
  assert.equal(cols, 1);
  assert.equal(rows, MAX_FIT_ROWS + 2);
  assert.equal(scroll, true);
});

test('computeLayout: a big early tile does not strand later tiles in the last column', () => {
  // One tall tile then several short ones: the retry-with-more-columns keeps the
  // shorts from all piling into the final column.
  const tiles = [{ id: 'big', span: 3 }, ...Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, span: 1 }))];
  const { placed, cols } = computeLayout(tiles);
  const used = new Set(placed.map((p) => p.col));
  assert.ok(used.size > 1 || cols === 1);
});

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

test('computeLayout: collapses a column left empty by the square starting count', () => {
  const tiles = [{ id: 'a', span: 2 }, { id: 'b', span: 1 }, { id: 'c', span: 3 }];
  const { placed, cols, rows, scroll } = computeLayout(tiles);
  assert.equal(scroll, false);
  assert.equal(cols, 2);
  assert.deepEqual(columnHeights(placed, cols), [3, 3]);
  // No declared column is left without a tile.
  for (const h of columnHeights(placed, cols)) assert.ok(h > 0);
});

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

test('tileWeightWithBody: no body weight adds nothing over the snooze weight', () => {
  const base = { activeCount: 2, snoozedCount: 1, cardStride: 80 };
  assert.equal(tileWeightWithBody(base), tileWeight(base));
  assert.equal(tileWeightWithBody({ ...base, bodyPx: 0 }), tileWeight(base));
});

test('tileWeightWithBody: bodyPx adds exactly that many px over the snooze composition, even with no sessions', () => {
  const stride = 80;
  const base = { activeCount: 2, snoozedCount: 3, cardStride: stride };
  const snoozePx = (2 * stride + SNOOZE_DIVIDER_PX + 3 * SNOOZE_STRIDE_PX);
  assert.equal(tileWeightWithBody({ ...base, bodyPx: 150 }), (snoozePx + 150) / stride);
  assert.equal(tileWeightWithBody({ activeCount: 0, snoozedCount: 0, cardStride: stride, bodyPx: 110 }), 110 / stride);
});

test('tileWeightWithBody: N child rows add N*STRIDE px, no divider', () => {
  const stride = 96;
  const base = tileWeightWithBody({ activeCount: 1, snoozedCount: 0, cardStride: stride });
  const withChildren = tileWeightWithBody({ activeCount: 1, snoozedCount: 0, cardStride: stride, childRowCount: 3 });
  assert.ok(Math.abs((withChildren - base) * stride - 3 * CHILD_STRIDE_PX) < 1e-9);
});

test('tileWeightWithBody: N workflow boxes add N*WORKFLOW_BOX_CHROME_PX px, independent of child rows', () => {
  const stride = 96;
  const base = tileWeightWithBody({ activeCount: 2, snoozedCount: 0, cardStride: stride });
  const withBoxes = tileWeightWithBody({ activeCount: 2, snoozedCount: 0, cardStride: stride, workflowBoxCount: 2 });
  assert.ok(Math.abs((withBoxes - base) * stride - 2 * WORKFLOW_BOX_CHROME_PX) < 1e-9);
});

test('tileWeightWithBody: N sub-agent rows across Z zones add N*ROW_STRIDE + Z*ZONE_BASE px', () => {
  const stride = 96;
  const base = tileWeightWithBody({ activeCount: 2, snoozedCount: 0, cardStride: stride });
  const withZones = tileWeightWithBody({ activeCount: 2, snoozedCount: 0, cardStride: stride, subagentRowCount: 3, subagentZoneCount: 2 });
  assert.ok(Math.abs((withZones - base) * stride - (3 * SUBAGENT_ROW_STRIDE_PX + 2 * SUBAGENT_ZONE_BASE_PX)) < 1e-9);
});

test('tileWeightWithBody: N full-view children add N*cardStride px, not N*CHILD_STRIDE_PX', () => {
  const stride = 96;
  const base = tileWeightWithBody({ activeCount: 1, snoozedCount: 0, cardStride: stride });
  const withFullView = tileWeightWithBody({ activeCount: 1, snoozedCount: 0, cardStride: stride, childFullViewCount: 2 });
  assert.ok(Math.abs((withFullView - base) * stride - 2 * stride) < 1e-9);
});
