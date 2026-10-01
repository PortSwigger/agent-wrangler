// The browser half of the builtin `todos` extension: the TODO zone in every task
// tile (Unassigned included), contributed to the `task.body` slot.
//
// Data is `graph.todos` (`{ bucket: [todo] }`, the server half's graph key); a
// bucket is a task id or the reserved Unassigned id, which the slot's ctx carries
// as `adhocId`. Changes are applied optimistically to the graph object the slot
// hands us, sent over this extension's own control types, and confirmed by the
// next graph — then `api.requestBoardRender()` redraws (which also re-sizes the
// tile through `weight`).
//
// The zone's rows are draggable, so the host is `claimDrag`-ed: core's card and
// tile drag handlers ignore any drag that starts in it. Reorder is within a tile;
// dropping a row on ANOTHER tile moves it there.
import {
  todoKeyToTaskId, todoLaunchIntent, todoWeightPx, reorderedTodoIds, tooltipPosition,
  todosOf, optimisticAdd, optimisticEdit, optimisticDelete, optimisticMove, optimisticReorder,
  TOOLTIP_MARGIN_PX,
} from './todo.js';
import { esc, todoZoneHtml, CHECK_ICON } from './markup.js';

// Same key the board used before this moved into an extension, so a user's
// collapsed zones carry over.
export const COLLAPSED_KEY = 'wrangler.collapsedTodoZones';

// Module state. One module instance per page (the loader imports it once), and
// `reset()` exists for tests.
const state = {
  api: null,
  graph: null,
  collapsed: new Set(),
  views: new Map(), // host element -> view
  byKey: new Map(), // bucket key -> view (latest mounted)
  drag: null, // { view, row, todoId, placeholder }
  tooltip: null,
};

export function reset() {
  Object.assign(state, { api: null, graph: null, collapsed: new Set(), views: new Map(), byKey: new Map(), drag: null, tooltip: null });
}

function loadCollapsed(api) {
  try {
    const raw = api.storage.raw(COLLAPSED_KEY).get();
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistCollapsed() {
  try { state.api.storage.raw(COLLAPSED_KEY).set(JSON.stringify([...state.collapsed])); } catch { /* storage unavailable */ }
}

function redraw() {
  state.api?.requestBoardRender();
}

// --- the slot contribution ---

// Tile height the zone wants, in px (see todoWeightPx). Called per tile per
// layout pass with the graph the board is rendering, so it also keeps our
// copy of the graph current for the handlers below.
export function weight(taskId, graph) {
  if (graph) state.graph = graph;
  return todoWeightPx(todosOf(graph || state.graph, taskId).length, state.collapsed.has(taskId));
}

function mount(el, api, ctx) {
  state.api = api;
  const view = { el, key: ctx.taskId, adhocId: ctx.adhocId || 'adhoc', unclaim: api.claimDrag(el) };
  state.views.set(el, view);
  state.byKey.set(view.key, view);
  el.classList.add('todo-ext');
  wire(view);
}

function update(el, ctx, graph) {
  if (graph) state.graph = graph;
  const view = state.views.get(el);
  if (!view) return;
  // An inline input in this host is mid-edit: replacing its markup would eat the
  // text. The board holds its own re-render while one is focused; this guards
  // any other path that updates the host.
  if (el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
  el.innerHTML = todoZoneHtml(todosOf(state.graph, view.key), view.key, state.collapsed.has(view.key));
}

function unmount(el) {
  const view = state.views.get(el);
  if (!view) return;
  state.views.delete(el);
  if (state.byKey.get(view.key) === view) state.byKey.delete(view.key);
  view.unclaim();
}

const send = (frame) => state.api.send(frame);
const wireId = (view) => todoKeyToTaskId(view.key, view.adhocId);

// --- interactions (event delegation on the host, which lives as long as the tile render) ---

function wire(view) {
  const { el } = view;
  el.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('.todo-pill')) { toggleCollapse(view); return; }
    const row = t.closest('.todo-row');
    if (!row) return;
    if (t.closest('.todo-spawn')) { e.stopPropagation(); spawn(view, row); }
    else if (t.closest('.todo-details')) { e.stopPropagation(); openDetails(view, row); }
    else if (t.closest('.todo-del')) {
      e.stopPropagation();
      const todoId = row.dataset.todoid;
      send({ type: 'todo-delete', taskId: wireId(view), todoId });
      if (optimisticDelete(state.graph, view.key, todoId)) redraw();
    } else if (t.closest('.todo-text') && !t.closest('.todo-text-input')) { e.stopPropagation(); beginEdit(view, row.querySelector('.todo-text')); }
  });
  el.addEventListener('mouseover', (e) => {
    const span = e.target.closest?.('.todo-text');
    if (span && !span.contains(e.relatedTarget)) showTooltip(span);
  });
  el.addEventListener('mouseout', (e) => {
    const span = e.target.closest?.('.todo-text');
    if (span && !span.contains(e.relatedTarget)) hideTooltip();
  });
  el.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.todo-row');
    if (!row) return;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'todo', todoId: row.dataset.todoid }));
    state.drag = { view, row, todoId: row.dataset.todoid, placeholder: null };
    setTimeout(() => {
      if (state.drag?.row !== row || !row.parentNode) return;
      const ph = document.createElement('div');
      ph.className = 'todo-placeholder';
      ph.style.height = `${row.offsetHeight}px`;
      row.parentNode.insertBefore(ph, row);
      row.classList.add('dragging-hidden');
      state.drag.placeholder = ph;
    }, 0);
  });
  el.addEventListener('dragend', () => endDrag());
  // The tile's whole cell is the drop surface, so an empty tile (whose host has
  // no height) can still take a dropped row.
  const cell = el.closest('.task-cell');
  if (cell && !cell._todoWired) {
    cell._todoWired = true;
    cell.addEventListener('dragover', (e) => onDragOver(cell, e));
    cell.addEventListener('dragleave', (e) => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('todo-drop-target'); });
    cell.addEventListener('drop', (e) => onDrop(cell, e));
  }
  if (cell) cell._todoView = view;
}

function toggleCollapse(view) {
  if (state.collapsed.has(view.key)) state.collapsed.delete(view.key);
  else state.collapsed.add(view.key);
  persistCollapsed();
  redraw();
}

function endDrag() {
  const d = state.drag;
  if (!d) return;
  d.row.classList.remove('dragging-hidden');
  d.placeholder?.remove();
  state.drag = null;
  for (const c of document.querySelectorAll('.todo-drop-target')) c.classList.remove('todo-drop-target');
  redraw();
}

function rowAfter(host, y) {
  for (const row of host.querySelectorAll(':scope > .todo-row[draggable="true"]:not(.dragging-hidden)')) {
    const r = row.getBoundingClientRect();
    if (y < r.top + r.height / 2) return row;
  }
  return null;
}

function onDragOver(cell, e) {
  const d = state.drag;
  const view = cell._todoView;
  if (!d || !view) return;
  e.preventDefault();
  if (view === d.view || view.key === d.view.key) {
    cell.classList.remove('todo-drop-target');
    if (!d.placeholder) return; // dragstart's deferred setTimeout has not run yet
    const after = rowAfter(view.el, e.clientY);
    const zone = view.el.querySelector(':scope > .todo-zone');
    if (after) view.el.insertBefore(d.placeholder, after);
    else if (zone) view.el.insertBefore(d.placeholder, zone);
    else view.el.appendChild(d.placeholder);
  } else {
    cell.classList.add('todo-drop-target');
  }
}

function onDrop(cell, e) {
  const d = state.drag;
  const view = cell._todoView;
  if (!d || !view) return;
  e.preventDefault();
  cell.classList.remove('todo-drop-target');
  if (view.key === d.view.key) {
    const beforeEl = d.placeholder?.nextElementSibling;
    const beforeId = beforeEl?.classList.contains('todo-row') ? beforeEl.dataset.todoid : null;
    const order = reorderedTodoIds(todosOf(state.graph, view.key).map((td) => td.id), d.todoId, beforeId);
    optimisticReorder(state.graph, view.key, order);
    send({ type: 'todo-reorder', taskId: wireId(view), order });
  } else if (optimisticMove(state.graph, d.todoId, d.view.key, view.key)) {
    send({ type: 'todo-move', todoId: d.todoId, fromTaskId: wireId(d.view), toTaskId: wireId(view) });
  }
  // dragend (always fired on the source) clears the drag state and redraws.
}

// Inline add: an input in the zone's anchor. Enter/blur commits, Escape cancels.
function beginAdd(key) {
  const view = state.byKey.get(key);
  const zone = view?.el.querySelector('.todo-zone');
  if (!zone) return;
  // A closed zone would hide the todo that is about to be typed; open it
  // (no redraw — the typed todo's own redraw below shows the rows).
  if (state.collapsed.delete(key)) persistCollapsed();
  zone.style.display = 'flex';
  zone.innerHTML = '<input class="todo-add-input" placeholder="New TODO…">';
  const input = zone.querySelector('.todo-add-input');
  input.focus();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const text = input.value.trim();
    if (save && text) {
      send({ type: 'todo-add', taskId: todoKeyToTaskId(key, view.adhocId), text });
      optimisticAdd(state.graph, key, text);
    }
    redraw();
  };
  input.addEventListener('keydown', (e) => {
    // stopPropagation: finish() re-renders this input away synchronously, so a
    // bubbling Enter would reach the window handler with the input already gone
    // and a selected "new session" slot would wrongly open the dispatch modal.
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Click-to-edit a row's text. Swap span -> input; Enter/blur commits, Escape cancels.
function beginEdit(view, span) {
  const row = span.closest('.todo-row');
  if (!row) return;
  hideTooltip();
  const todoId = row.dataset.todoid;
  const current = span.textContent;
  span.innerHTML = `<input class="todo-text-input" value="${esc(current)}">`;
  const input = span.querySelector('.todo-text-input');
  input.focus();
  input.select();
  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    const text = input.value.trim();
    if (save && text && text !== current) {
      send({ type: 'todo-edit', taskId: wireId(view), todoId, text });
      optimisticEdit(state.graph, view.key, todoId, { text });
    }
    redraw();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function showTooltip(span) {
  if (span.scrollWidth <= span.clientWidth) return;
  if (!state.tooltip) {
    state.tooltip = document.createElement('div');
    state.tooltip.className = 'todo-tooltip';
    document.body.appendChild(state.tooltip);
  }
  const tip = state.tooltip;
  tip.textContent = span.textContent;
  const r = span.getBoundingClientRect();
  tip.style.left = `${Math.round(r.left)}px`;
  tip.style.maxWidth = `${Math.max(160, Math.min(Math.round(r.width * 1.6), window.innerWidth - 2 * TOOLTIP_MARGIN_PX))}px`;
  tip.classList.add('show');
  const { left, top } = tooltipPosition(r, tip.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTooltip() {
  state.tooltip?.classList.remove('show');
}

function openDetails(view, row) {
  const todoId = row.dataset.todoid;
  const td = todosOf(state.graph, view.key).find((item) => item.id === todoId);
  if (!td) return;
  const overlay = document.createElement('div');
  overlay.className = 'todo-editor-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'todo-editor-heading');
  overlay.innerHTML = `<div class="modal-card todo-editor-card">
    <h3 id="todo-editor-heading">Edit TODO</h3>
    <label for="todo-editor-title">Title</label>
    <input id="todo-editor-title" autocomplete="off">
    <label for="todo-editor-description">Description</label>
    <textarea id="todo-editor-description" rows="10" placeholder="Findings, remaining work, next step…"></textarea>
    <p class="todo-editor-error" role="alert" hidden></p>
    <div class="modal-actions"><button class="ghost todo-editor-cancel">Cancel</button><button class="primary todo-editor-save">Save</button></div>
  </div>`;
  const title = overlay.querySelector('#todo-editor-title');
  const description = overlay.querySelector('#todo-editor-description');
  const error = overlay.querySelector('.todo-editor-error');
  title.value = td.text;
  description.value = td.description || '';
  const close = () => overlay.remove();
  overlay.querySelector('.todo-editor-cancel').addEventListener('click', close);
  overlay.querySelector('.todo-editor-save').addEventListener('click', () => {
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    const nextDescription = description.value.trim();
    const textChanged = text !== td.text;
    const descriptionChanged = nextDescription !== (td.description || '');
    if (textChanged || descriptionChanged) {
      // The todo may have moved bucket while the dialog was open.
      const key = Object.keys(state.graph?.todos || {}).find((bucket) => todosOf(state.graph, bucket).some((item) => item.id === todoId));
      if (!key) {
        error.textContent = 'This TODO no longer exists.';
        error.hidden = false;
        return;
      }
      send({
        type: 'todo-edit', taskId: todoKeyToTaskId(key, view.adhocId), todoId,
        ...(textChanged ? { text } : {}),
        ...(descriptionChanged ? { description: nextDescription } : {}),
      });
      optimisticEdit(state.graph, key, todoId, { ...(textChanged ? { text } : {}), ...(descriptionChanged ? { description: nextDescription } : {}) });
      redraw();
    }
    close();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  document.body.appendChild(overlay);
  (td.description ? description : title).focus();
}

// Start a session from a TODO: the dispatch modal opens pre-filled with the
// todo's text, locked to its task, and the todo is consumed (deleted) only once
// the dispatch is acknowledged — a cancelled modal leaves it untouched.
async function spawn(view, row) {
  const todoId = row.dataset.todoid;
  const key = view.key;
  const td = todosOf(state.graph, key).find((x) => x.id === todoId);
  if (!td) return;
  const taskId = todoKeyToTaskId(key, view.adhocId);
  let ack;
  try {
    ack = await state.api.openDispatch({ taskId, intent: todoLaunchIntent(td), lockTask: true });
  } catch (err) {
    // A dispatch already in flight: nothing was opened, nothing to consume.
    console.warn("[ext:todos] spawn refused", err);
    return;
  }
  if (!ack) return;
  send({ type: 'todo-delete', taskId, todoId });
  if (optimisticDelete(state.graph, key, todoId)) redraw();
}

export default {
  register(registrar) {
    state.api = registrar.api;
    state.collapsed = loadCollapsed(registrar.api);
    registrar.register('task.body', { id: 'todos', mount, update, unmount, weight });
    registrar.register('task.action', {
      id: 'new-todo',
      items: (task) => [{ label: 'New TODO', icon: CHECK_ICON, run: () => beginAdd(task.id) }],
    });
  },
};
