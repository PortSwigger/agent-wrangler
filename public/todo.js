// Pure per-task TODO logic, split out of app.js so it can be unit-tested without a
// DOM (mirrors snooze.js). The browser loads this as a module; node imports it
// directly. A TODO is the cheapest tier of work — a spawn-template below
// dormant/snoozed — so its rows weigh fractionally in the tile-span math, lighter
// than a snoozed row.

import { tileWeight } from './snooze.js';

// The reserved order id for the movable Ad-hoc/Unassigned tile (mirrors app.js's
// ADHOC_ID and the server's TaskStore.ADHOC). A todo row keyed here belongs to no
// task, so its WS messages carry taskId: null (the server coerces null ⇒ adhoc).
export const ADHOC_ID = 'adhoc';

// Minimized-row geometry, in px, feeding the tile-span weight. Measured off the
// rendered .todo-row / .todo-divider (like SNOOZE_STRIDE_PX). TODO_STRIDE_PX is
// the top-to-top stride (26px row + 8px flex gap in .task-body = 34px).
// TODO_DIVIDER_PX covers the one-time overhead: divider + flex gap + zone height
// measured: (239-95) - 3*34 = 42px with 3 rows.
export const TODO_STRIDE_PX = 34;
export const TODO_DIVIDER_PX = 42;

// A nested child session (a workflow worker, or any other spawn absorbed into a
// parent's spine — see workflow.js computeAbsorption) renders as a compact
// `.worker-row`, not a full card, so it weighs like a todo/snoozed row rather
// than a full active session. Reuses the same stride as SNOOZE_STRIDE_PX/
// TODO_STRIDE_PX (a `.worker-row` is close in height, and tileSpan's own cap on
// secondary weight makes sub-px precision here low-value — once a tile's
// secondary content exceeds one row-equivalent it's clamped regardless). No
// divider: unlike the todo/snoozed zones, a child spine has no label row of its
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

// A todo-zone key (task.id or the ADHOC_ID sentinel) back to the taskId the server
// expects on the wire: null for adhoc (the handler coerces null ⇒ adhoc), the real
// id otherwise. Used at every send() and the DnD payload boundary.
export function todoKeyToTaskId(key) {
  return !key || key === ADHOC_ID ? null : key;
}

export const TOOLTIP_MARGIN_PX = 8;
export const TOOLTIP_GAP_PX = 6;
export function tooltipPosition(anchor, tip, viewport) {
  const m = TOOLTIP_MARGIN_PX;
  const left = Math.max(m, Math.min(anchor.left, viewport.width - tip.width - m));
  const below = anchor.bottom + TOOLTIP_GAP_PX;
  const top = below + tip.height > viewport.height ? anchor.top - tip.height - TOOLTIP_GAP_PX : below;
  return { left: Math.round(left), top: Math.round(top) };
}

// Tile height as fractional card-equivalents, composing the snooze weight with the
// todo rows and any absorbed child-session rows: snooze px (active cards + snoozed
// rows + their divider) plus, when any todos exist, a one-time todo divider and a
// fractional stride per todo row, plus a fractional stride per visible child row
// (no divider — see CHILD_STRIDE_PX). Feeds rowSpan(weight, perRow) in app.js.
// Computed off snooze.js's tileWeight so that module stays untouched (multiply
// back to px, add todo/child px, divide back to units).
export function tileWeightWithTodos({
  activeCount, snoozedCount, cardStride, todoCount = 0, childRowCount = 0, workflowBoxCount = 0,
  subagentRowCount = 0, subagentZoneCount = 0,
}) {
  const px = tileWeight({ activeCount, snoozedCount, cardStride }) * cardStride
    + (todoCount > 0 ? TODO_DIVIDER_PX + todoCount * TODO_STRIDE_PX : 0)
    + childRowCount * CHILD_STRIDE_PX
    + workflowBoxCount * WORKFLOW_BOX_CHROME_PX
    + subagentRowCount * SUBAGENT_ROW_STRIDE_PX + subagentZoneCount * SUBAGENT_ZONE_BASE_PX;
  return px / cardStride;
}
