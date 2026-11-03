import { tileWeight, listedAsleep } from './snooze.js';

// A nested child session (a workflow worker, or any other spawn absorbed into a
// parent's spine — see workflow.js computeAbsorption) renders as a compact
// `.worker-row`, not a full card, so it weighs like a snoozed row rather
// than a full active session. Reuses the same stride as SNOOZE_STRIDE_PX
// (a `.worker-row` is close in height, and tileSpan's own cap on
// secondary weight makes sub-px precision here low-value — once a tile's
// secondary content exceeds one row-equivalent it's clamped regardless). No
// divider: unlike the snoozed zone, a child spine has no label row of its
// own (a workflow box's header is part of its parent's own card weight instead).
export const CHILD_STRIDE_PX = 34;

// A workflow run (cards.js's workflowBoxHtml) wraps its orchestrator + spine in
// its OWN violet box — border, 9px padding, and a "Workflow" header row — none
// of which a plain child-spine has (styles.css: .child-spine is a bare div, no
// wrapping box at all). That chrome exists the moment a top-level session
// isWorkflowRun, regardless of whether it has any workers yet (a "solo" run
// still gets the box) or whether its spine is currently collapsed (collapsing
// only hides the spine — see app.js's toggleWorkflowCollapse — the box, border
// and header stay put). So this is charged per uncollapsed-or-not workflow box,
// never per child row. Measured off a live rendered `.workflow-box` (dev
// instance, box height − card height − spine height): 44px with no spine
// visible (solo run, or collapsed — border+padding 20px, header 16px, one
// internal 8px gap to the orchestrator card), 52px once a spine renders (an
// extra 8px gap between the card and the spine). Charged as a flat 52px
// regardless of collapse state — a deliberate ~8px overcount on the
// solo/collapsed case rather than threading a 4th count through just for that,
// well within the secondary-weight cap's existing slack.
export const WORKFLOW_BOX_CHROME_PX = 52;

// A card's expanded sub-agent zone (cards.js subagentZoneHtml) is chrome
// tileSpan never budgeted for at all — unlike childRowCount/workflowBoxCount,
// which cover absorbed sessions, a card's OWN zone can grow a plain top-level
// card past its assumed CARD_STRIDE_PX and was overflowing the tile (verified
// against a live board: a card with one shown sub-agent row measured 113.4px
// against the normal 77.4px). Measured off .subagent-zone (styles.css): 12px
// margin-top, -2px margin-bottom, each .subagent-row a fixed 26px with a 6px
// inter-row gap — so N rows cost `4 + 32N` px (10 + 26N + 6(N-1) - 2). Charged
// per card that actually renders a zone (subagentZoneHtml renders nothing for
// a collapsed pill or a session with no currently-recent sub-agents), so the
// caller sums both a row count and a zone-occurrence count across the tile.
export const SUBAGENT_ROW_STRIDE_PX = 32; // row (26) + inter-row gap (6)
export const SUBAGENT_ZONE_BASE_PX = 4;   // margin-top(12) + margin-bottom(-2) - one row's gap folded into the stride above

export function tileWeightWithBody({
  activeCount, snoozedCount, cardStride, bodyPx = 0, childRowCount = 0,
  workflowBoxCount = 0, subagentRowCount = 0, subagentZoneCount = 0, childFullViewCount = 0, snoozedCollapsed = false,
}) {
  const px = tileWeight({ activeCount, snoozedCount, cardStride, snoozedCollapsed }) * cardStride
    + bodyPx
    + childRowCount * CHILD_STRIDE_PX
    // A full-view child draws as a real card, so it costs a whole cardStride,
    // not CHILD_STRIDE_PX — see cards.js childRowHtml / layout.js tileSpan.
    + childFullViewCount * cardStride
    + workflowBoxCount * WORKFLOW_BOX_CHROME_PX
    + subagentRowCount * SUBAGENT_ROW_STRIDE_PX + subagentZoneCount * SUBAGENT_ZONE_BASE_PX;
  return px / cardStride;
}


export const MAX_COLS = 6;
export const MAX_ONSCREEN_ROWS = 5;
export const MAX_FIT_ROWS = MAX_ONSCREEN_ROWS;
export const MAX_SPAN = 4;
export const CARD_STRIDE_PX = 85;
export const TILE_CHROME_PX = 37;
export const GRID_GAP_PX = 12;
export const GRID_PADDING_PX = 14;
export const MIN_COL_PX = 380;
export const GRID_CHROME_X_PX = 2 * GRID_PADDING_PX;

export function gridRowHeight(clientHeight, trayHeight = null) {
  const trayPx = trayHeight == null ? 0 : trayHeight + GRID_GAP_PX;
  return Math.max(1, (clientHeight - trayPx - 2 * GRID_PADDING_PX - (MAX_ONSCREEN_ROWS - 1) * GRID_GAP_PX) / MAX_ONSCREEN_ROWS);
}

export function columnsForWidth(gridEl) {
  const usable = (gridEl.clientWidth || 0) - GRID_CHROME_X_PX;
  return Math.max(1, Math.floor(usable / MIN_COL_PX));
}

export function computeLayout(tiles, maxCols = MAX_COLS) {
  const wanted = new Map(tiles.map((tile) => [tile.id, tile.span]));
  tiles = tiles.map((tile) => ({ ...tile, span: Math.max(1, Math.min(tile.span, MAX_SPAN)) }));
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
  const squareCols = Math.ceil(Math.sqrt(total));
  const cap = Math.max(1, Math.min(MAX_COLS, maxCols));
  const seed = Math.min(squareCols, Math.max(2, Math.ceil(total / 3)));
  let best;
  for (let cols = Math.min(cap, Math.max(1, seed)); ; cols++) {
    best = pack(cols);
    if (best.rows <= MAX_FIT_ROWS || cols >= cap) break;
  }
  while (best.cols > 1) {
    const used = best.heights.filter((h) => h > 0).length;
    if (used >= best.cols) break;
    const shrunk = pack(used);
    if (shrunk.rows > MAX_FIT_ROWS) break;
    best = shrunk;
  }
  if (best.rows <= MAX_ONSCREEN_ROWS) {
    for (const tile of best.placed) {
      if (wanted.get(tile.id) <= MAX_SPAN || best.heights[tile.col] >= MAX_ONSCREEN_ROWS) continue;
      const oldEnd = tile.rowStart + tile.span;
      tile.span++;
      for (const below of best.placed) {
        if (below.col === tile.col && below.rowStart >= oldEnd) below.rowStart++;
      }
      best.heights[tile.col]++;
    }
    best.rows = Math.max(...best.heights, 1);
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
      const overflow = list.reduce((height, tile) => height + tile.span, 0) > MAX_ONSCREEN_ROWS;
      let row = 0;
      for (const p of list) {
        const span = overflow ? Math.min(p.span, MAX_SPAN) : p.span;
        result.push({ ...p, span, rowStart: row });
        row += span;
      }
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

export function tileSpan(
  sessions, rowHeight, bodyPx = 0, phaseOf, childRowCount = 0, absorbedChildCount = childRowCount, workflowBoxCount = 0,
  subagentRowCount = 0, subagentZoneCount = 0, childFullViewCount = 0, snoozedCollapsed = false,
) {
  const snoozedCount = listedAsleep(sessions, phaseOf).length;
  const asleepCount = sessions.filter((s) => phaseOf(s) === 'asleep').length;
  const topLevelActiveCount = sessions.length - asleepCount - absorbedChildCount;
  const totalWeight = tileWeightWithBody({
    activeCount: topLevelActiveCount, snoozedCount, cardStride: CARD_STRIDE_PX, bodyPx, childRowCount, workflowBoxCount,
    subagentRowCount, subagentZoneCount, childFullViewCount, snoozedCollapsed,
  });
  const contentPx = totalWeight * CARD_STRIDE_PX + TILE_CHROME_PX;
  return Math.max(1, Math.min(MAX_ONSCREEN_ROWS, Math.ceil((contentPx + GRID_GAP_PX) / (rowHeight + GRID_GAP_PX))));
}
