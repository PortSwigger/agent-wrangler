import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TODO_STRIDE_PX, TODO_DIVIDER_PX, CHILD_STRIDE_PX, WORKFLOW_BOX_CHROME_PX, ADHOC_ID,
  SUBAGENT_ROW_STRIDE_PX, SUBAGENT_ZONE_BASE_PX,
  todoKeyToTaskId, tileWeightWithTodos,
  tooltipPosition, TOOLTIP_MARGIN_PX, TOOLTIP_GAP_PX,
} from './todo.js';
import { tileWeight, SNOOZE_DIVIDER_PX, SNOOZE_STRIDE_PX } from './snooze.js';

test('TODO_STRIDE_PX / TODO_DIVIDER_PX are exported positive numbers', () => {
  assert.equal(typeof TODO_STRIDE_PX, 'number');
  assert.equal(typeof TODO_DIVIDER_PX, 'number');
  assert.ok(TODO_STRIDE_PX > 0);
  assert.ok(TODO_DIVIDER_PX > 0);
});

test('todoKeyToTaskId: the adhoc sentinel maps to null, real ids pass through', () => {
  assert.equal(todoKeyToTaskId(ADHOC_ID), null);
  assert.equal(todoKeyToTaskId('adhoc'), null);
  assert.equal(todoKeyToTaskId('task_123'), 'task_123');
  assert.equal(todoKeyToTaskId(null), null);
  assert.equal(todoKeyToTaskId(undefined), null);
});

test('tileWeightWithTodos: zero todos adds nothing over the snooze weight', () => {
  const stride = 80;
  const base = { activeCount: 2, snoozedCount: 1, cardStride: stride };
  assert.equal(
    tileWeightWithTodos({ ...base, todoCount: 0 }),
    tileWeight(base),
  );
});

test('tileWeightWithTodos: N todos add DIVIDER + N*STRIDE px over the snooze composition', () => {
  const stride = 80;
  const base = { activeCount: 2, snoozedCount: 3, cardStride: stride };
  const snoozePx = (2 * stride + SNOOZE_DIVIDER_PX + 3 * SNOOZE_STRIDE_PX);
  const expected = (snoozePx + TODO_DIVIDER_PX + 4 * TODO_STRIDE_PX) / stride;
  assert.equal(tileWeightWithTodos({ ...base, todoCount: 4 }), expected);
});

test('tileWeightWithTodos: todos render a tile even with no sessions', () => {
  const stride = 80;
  const w = tileWeightWithTodos({ activeCount: 0, snoozedCount: 0, cardStride: stride, todoCount: 2 });
  assert.equal(w, (TODO_DIVIDER_PX + 2 * TODO_STRIDE_PX) / stride);
  assert.ok(w > 0);
});

test('tileWeightWithTodos: N child rows add N*STRIDE px, no divider', () => {
  const stride = 96;
  const base = tileWeightWithTodos({ activeCount: 1, snoozedCount: 0, cardStride: stride, todoCount: 0 });
  const withChildren = tileWeightWithTodos({ activeCount: 1, snoozedCount: 0, cardStride: stride, todoCount: 0, childRowCount: 3 });
  assert.ok(Math.abs((withChildren - base) * stride - 3 * CHILD_STRIDE_PX) < 1e-9);
});

test('tileWeightWithTodos: zero child rows add nothing over the todo composition', () => {
  const base = { activeCount: 2, snoozedCount: 0, cardStride: 96, todoCount: 1 };
  assert.equal(tileWeightWithTodos({ ...base, childRowCount: 0 }), tileWeightWithTodos(base));
});

test('tileWeightWithTodos: N workflow boxes add N*WORKFLOW_BOX_CHROME_PX px, independent of child rows', () => {
  const stride = 96;
  const base = tileWeightWithTodos({ activeCount: 2, snoozedCount: 0, cardStride: stride, todoCount: 0 });
  const withBoxes = tileWeightWithTodos({ activeCount: 2, snoozedCount: 0, cardStride: stride, todoCount: 0, workflowBoxCount: 2 });
  assert.ok(Math.abs((withBoxes - base) * stride - 2 * WORKFLOW_BOX_CHROME_PX) < 1e-9);
});

test('tileWeightWithTodos: zero workflow boxes add nothing over the child-row composition', () => {
  const base = { activeCount: 1, snoozedCount: 0, cardStride: 96, todoCount: 0, childRowCount: 2 };
  assert.equal(tileWeightWithTodos({ ...base, workflowBoxCount: 0 }), tileWeightWithTodos(base));
});

test('tileWeightWithTodos: N sub-agent rows across Z zones add N*ROW_STRIDE + Z*ZONE_BASE px', () => {
  const stride = 96;
  const base = tileWeightWithTodos({ activeCount: 2, snoozedCount: 0, cardStride: stride, todoCount: 0 });
  const withZones = tileWeightWithTodos({
    activeCount: 2, snoozedCount: 0, cardStride: stride, todoCount: 0, subagentRowCount: 3, subagentZoneCount: 2,
  });
  const expectedPx = 3 * SUBAGENT_ROW_STRIDE_PX + 2 * SUBAGENT_ZONE_BASE_PX;
  assert.ok(Math.abs((withZones - base) * stride - expectedPx) < 1e-9);
});

test('tileWeightWithTodos: zero sub-agent rows/zones add nothing over the workflow-box composition', () => {
  const base = { activeCount: 2, snoozedCount: 0, cardStride: 96, todoCount: 0, workflowBoxCount: 1 };
  assert.equal(
    tileWeightWithTodos({ ...base, subagentRowCount: 0, subagentZoneCount: 0 }),
    tileWeightWithTodos(base),
  );
});

test('tooltipPosition: anchors under the row with the gap when it fits', () => {
  const anchor = { left: 100, right: 300, top: 90, bottom: 104 };
  const tip = { width: 200, height: 40 };
  const p = tooltipPosition(anchor, tip, { width: 1200, height: 800 });
  assert.equal(p.left, 100);
  assert.equal(p.top, 104 + TOOLTIP_GAP_PX);
});

test('tooltipPosition: flips above the row when below would overflow the viewport', () => {
  const anchor = { left: 100, right: 300, top: 760, bottom: 780 };
  const tip = { width: 200, height: 50 };
  const p = tooltipPosition(anchor, tip, { width: 1200, height: 800 });
  assert.equal(p.top, 760 - 50 - TOOLTIP_GAP_PX);
});

test('tooltipPosition: clamps against the right edge with the margin', () => {
  const vw = 760;
  const anchor = { left: 700, right: 745, top: 90, bottom: 104 };
  const tip = { width: 300, height: 40 };
  const p = tooltipPosition(anchor, tip, { width: vw, height: 800 });
  assert.equal(p.left, vw - tip.width - TOOLTIP_MARGIN_PX);
  assert.ok(p.left + tip.width <= vw - TOOLTIP_MARGIN_PX);
});

test('tooltipPosition: clamps against the left edge with the margin', () => {
  const anchor = { left: 2, right: 60, top: 90, bottom: 104 };
  const tip = { width: 200, height: 40 };
  const p = tooltipPosition(anchor, tip, { width: 1200, height: 800 });
  assert.equal(p.left, TOOLTIP_MARGIN_PX);
});
