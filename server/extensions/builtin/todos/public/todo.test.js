import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TODO_STRIDE_PX, TODO_DIVIDER_PX, ADHOC_ID,
  todoKeyToTaskId, todoWeightPx, reorderedTodoIds, todoLaunchIntent,
  tooltipPosition, TOOLTIP_MARGIN_PX, TOOLTIP_GAP_PX,
} from './todo.js';

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

test('todoLaunchIntent includes a description when starting a rich TODO', () => {
  assert.equal(todoLaunchIntent({ text: 'Investigate' }), 'Investigate');
  assert.equal(todoLaunchIntent({ text: 'Investigate', description: 'Found a race.\nNext: add test.' }), 'Investigate\n\nFound a race.\nNext: add test.');
});

test('todoWeightPx: none charges nothing, N charges DIVIDER + N*STRIDE, collapsed keeps only the divider', () => {
  assert.equal(todoWeightPx(0), 0);
  assert.equal(todoWeightPx(0, true), 0);
  assert.equal(todoWeightPx(4), TODO_DIVIDER_PX + 4 * TODO_STRIDE_PX);
  assert.equal(todoWeightPx(4, true), TODO_DIVIDER_PX);
});

test('todoKeyToTaskId honours an injected adhoc id', () => {
  assert.equal(todoKeyToTaskId('x', 'x'), null);
  assert.equal(todoKeyToTaskId('adhoc', 'x'), 'adhoc');
});

test('reorderedTodoIds: moves the dragged id to before the target id', () => {
  assert.deepEqual(reorderedTodoIds(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(reorderedTodoIds(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
});

test('reorderedTodoIds: a null beforeId appends the dragged id at the end', () => {
  assert.deepEqual(reorderedTodoIds(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
});

test('reorderedTodoIds: dropping back onto its own slot is a no-op', () => {
  assert.deepEqual(reorderedTodoIds(['a', 'b', 'c'], 'b', 'c'), ['a', 'b', 'c']);
});

test('reorderedTodoIds: an unknown beforeId falls back to appending at the end', () => {
  assert.deepEqual(reorderedTodoIds(['a', 'b', 'c'], 'a', 'nope'), ['b', 'c', 'a']);
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

test('optimistic helpers mutate the todos map in place, keep it sparse, and report whether anything changed', async () => {
  const { todosOf, optimisticAdd, optimisticEdit, optimisticDelete, optimisticMove, optimisticReorder } = await import('./todo.js');
  const g = { todos: { a: [{ id: '1', text: 'one' }, { id: '2', text: 'two', description: 'd' }] } };
  assert.deepEqual(todosOf(g, 'zzz'), []);
  assert.deepEqual(todosOf(null, 'a'), []);
  assert.equal(optimisticAdd(g, 'b', 'new', 5), true);
  assert.deepEqual(g.todos.b, [{ id: 'tmp_5', text: 'new', createdAt: 5 }]);
  assert.equal(optimisticAdd(null, 'b', 'x'), false);
  assert.equal(optimisticEdit(g, 'a', '2', { text: 'TWO', description: '' }), true);
  assert.deepEqual(g.todos.a[1], { id: '2', text: 'TWO' });
  assert.equal(optimisticEdit(g, 'a', 'nope', { text: 'x' }), false);
  assert.equal(optimisticMove(g, '1', 'a', 'b'), true);
  assert.deepEqual(g.todos.a.map((t) => t.id), ['2']);
  assert.deepEqual(g.todos.b.map((t) => t.id), ['tmp_5', '1']);
  assert.equal(optimisticMove(g, '1', 'b', 'b'), false);
  assert.equal(optimisticReorder(g, 'b', ['1', 'tmp_5', 'ghost']), true);
  assert.deepEqual(g.todos.b.map((t) => t.id), ['1', 'tmp_5']);
  assert.equal(optimisticDelete(g, 'a', '2'), true);
  assert.equal('a' in g.todos, false);
  assert.equal(optimisticDelete(g, 'a', '2'), false);
});
