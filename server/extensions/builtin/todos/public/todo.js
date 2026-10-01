// Pure per-task TODO logic for the todos extension's browser half, split out of
// client.js so it can be unit-tested without a DOM. The browser loads this as a
// module (client.js imports it); node imports it directly. A TODO is the cheapest
// tier of work — a spawn-template below dormant/snoozed — so its rows weigh
// fractionally in the tile-span math (see `todoWeightPx`).

// The reserved id of the Unassigned tile, as a fallback only: the `task.body` ctx
// carries the real one (`adhocId`). A todo row keyed here belongs to no task, so
// its WS messages carry taskId: null (the server coerces null ⇒ adhoc).
export const ADHOC_ID = 'adhoc';

export function todoLaunchIntent(todo) {
  return todo.description ? `${todo.text}\n\n${todo.description}` : todo.text;
}

// Minimized-row geometry, in px, feeding the tile-span weight. Measured off the
// rendered .todo-row / .todo-divider (like SNOOZE_STRIDE_PX). TODO_STRIDE_PX is
// the top-to-top stride (26px row + 8px flex gap in .task-body = 34px).
// TODO_DIVIDER_PX covers the one-time overhead: divider + flex gap + zone height
// measured: (239-95) - 3*34 = 42px with 3 rows.
export const TODO_STRIDE_PX = 34;
export const TODO_DIVIDER_PX = 42;

// A todo-zone key (task.id or the ADHOC_ID sentinel) back to the taskId the server
// expects on the wire: null for adhoc (the handler coerces null ⇒ adhoc), the real
// id otherwise. Used at every send() and the DnD payload boundary.
export function todoKeyToTaskId(key, adhocId = ADHOC_ID) {
  return !key || key === adhocId ? null : key;
}

// The px of tile height a task's TODO zone wants, for the `task.body` `weight()`.
// A collapsed zone still charges the divider (the chrome stays put) but drops
// the rows; no todos charges nothing.
export function todoWeightPx(count, collapsed = false) {
  if (!(count > 0)) return 0;
  return TODO_DIVIDER_PX + (collapsed ? 0 : count * TODO_STRIDE_PX);
}

// The full order for a bucket after dragging `draggedId` to sit just before
// `beforeId` (null = the end, or any id no longer in the list — the placeholder's
// own position already fell back to appending there, so an unresolved id gets the
// same treatment here). Pure so the drop handler's target computation stays
// testable without a DOM.
export function reorderedTodoIds(currentIds, draggedId, beforeId) {
  const rest = currentIds.filter((id) => id !== draggedId);
  const at = beforeId == null ? -1 : rest.indexOf(beforeId);
  return at < 0 ? [...rest, draggedId] : [...rest.slice(0, at), draggedId, ...rest.slice(at)];
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

// --- optimistic edits on the graph's `todos` map (`{ bucket: [todo] }`) ---
// The browser applies a change to the graph object it was handed, sends the
// frame, and lets the next graph confirm — the same pattern the board always
// used. Each helper mutates in place and returns whether anything changed; the
// map is kept sparse like the server's.

export function todosOf(graph, key) {
  return (graph && graph.todos && graph.todos[key]) || [];
}

export function optimisticAdd(graph, key, text, now = Date.now()) {
  if (!graph) return false;
  graph.todos = graph.todos || {};
  (graph.todos[key] || (graph.todos[key] = [])).push({ id: `tmp_${now}`, text, createdAt: now });
  return true;
}

export function optimisticEdit(graph, key, todoId, patch) {
  const td = todosOf(graph, key).find((x) => x.id === todoId);
  if (!td) return false;
  if (patch.text !== undefined) td.text = patch.text;
  if (patch.description !== undefined) {
    if (patch.description) td.description = patch.description;
    else delete td.description;
  }
  return true;
}

export function optimisticDelete(graph, key, todoId) {
  const list = todosOf(graph, key);
  if (!list.some((x) => x.id === todoId)) return false;
  const next = list.filter((x) => x.id !== todoId);
  if (next.length) graph.todos[key] = next;
  else delete graph.todos[key];
  return true;
}

export function optimisticMove(graph, todoId, fromKey, toKey) {
  if (fromKey === toKey) return false;
  const td = todosOf(graph, fromKey).find((x) => x.id === todoId);
  if (!td) return false;
  optimisticDelete(graph, fromKey, todoId);
  (graph.todos[toKey] || (graph.todos[toKey] = [])).push(td);
  return true;
}

export function optimisticReorder(graph, key, order) {
  const list = todosOf(graph, key);
  if (!list.length) return false;
  const byId = new Map(list.map((td) => [td.id, td]));
  graph.todos[key] = order.map((id) => byId.get(id)).filter(Boolean);
  return true;
}
