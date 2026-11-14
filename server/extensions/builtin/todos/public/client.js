// The browser half of the builtin `todos` extension: the TODO zone in every task
// tile (Unassigned included), contributed to the `task.body` slot.
//
// Data is `todos` (`{ bucket: [todo] }`) in this extension's own state,
// `api.state()`; a bucket is a task id or the reserved Unassigned id, which the
// slot's ctx carries as `adhocId`. Changes are applied optimistically to a
// working copy of it, sent over this extension's own control types, and
// confirmed by the next state frame — then `api.requestBoardRender()` redraws
// (which also re-sizes the tile through `weight`).
//
// The zone's rows are draggable, so the host is `claimDrag`-ed: core's card and
// tile drag handlers ignore any drag that starts in it. Reorder is within a tile;
// dropping a row on ANOTHER tile of the same deck moves it there.
//
// On a board with several decks another deck's task tile carries `deckId` and
// `deckTaskId`: its todos are that deck's `api.state({ deck })`, keyed by the
// task's id there, and every change is sent to that deck alone. A deck running
// this extension with another boardApi shows an Incompatible note instead.
import {
  todoKeyToTaskId, todoLaunchIntent, todoWeightPx, reorderedTodoIds, tooltipPosition,
  todosOf, optimisticAdd, optimisticEdit, optimisticDelete, optimisticMove, optimisticReorder,
  TOOLTIP_MARGIN_PX, TODO_INCOMPATIBLE_PX,
} from './todo.js';
import { esc, todoZoneHtml, todoIncompatibleHtml, CHECK_ICON } from './markup.js';

// Same key the board used before this moved into an extension, so a user's
// collapsed zones carry over.
export const COLLAPSED_KEY = 'wrangler.collapsedTodoZones';

// Module state. One module instance per page (the loader imports it once), and
// `reset()` exists for tests.
const state = {
  api: null,
  graph: null,
  seen: null,
  decks: new Map(), // another deck's id -> { seen, graph }, its working copy
  collapsed: new Set(),
  views: new Map(), // host element -> view
  byKey: new Map(), // bucket key -> view (latest mounted)
  drag: null, // { view, row, todoId, placeholder }
  tooltip: null,
};

export function reset() {
  Object.assign(state, { api: null, graph: null, seen: null, decks: new Map(), collapsed: new Set(), views: new Map(), byKey: new Map(), drag: null, tooltip: null });
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

// What the zone draws from: a working copy of this extension's state, edited
// optimistically until the next state frame replaces it. A board without
// api.state() still hands the todos over on the graph.
function data(graph) {
  const own = state.api?.state?.() ?? null;
  if (own == null) {
    if (graph) state.graph = graph;
    return state.graph;
  }
  if (own !== state.seen || !state.graph) {
    state.seen = own;
    state.graph = { todos: structuredClone(own.todos ?? {}) };
  }
  return state.graph;
}

// Another deck's working copy, the same way.
function deckData(deckId) {
  const own = state.api?.state?.({ deck: deckId }) ?? null;
  let entry = state.decks.get(deckId);
  if (!entry || own !== entry.seen) {
    entry = { seen: own, graph: { todos: structuredClone(own?.todos ?? {}) } };
    state.decks.set(deckId, entry);
  }
  return entry.graph;
}

function incompatibleDeck(deckId) {
  const decks = typeof state.api?.decks === 'function' ? state.api.decks() : [];
  return decks.find((d) => d.deckId === deckId && d.status === 'incompatible') || null;
}

// A view's working copy and its bucket in it: the board's own deck's, keyed by
// the tile's key, or another deck's, keyed by the task's id on that deck.
const graphOf = (view) => (view.deck ? deckData(view.deck) : state.graph);
const bucketOf = (view) => (view.deck ? view.localId : view.key);

// Tile height the zone wants, in px (see todoWeightPx). Called per tile per
// layout pass with the graph the board is rendering, so it also keeps our
// copy of the graph current for the handlers below.
export function weight(taskId, graph, task) {
  if (typeof task?.deckId === 'string') {
    if (incompatibleDeck(task.deckId)) return TODO_INCOMPATIBLE_PX;
    return todoWeightPx(todosOf(deckData(task.deckId), task.deckTaskId).length, state.collapsed.has(taskId));
  }
  return todoWeightPx(todosOf(data(graph), taskId).length, state.collapsed.has(taskId));
}

function mount(el, api, ctx) {
  state.api = api;
  const deck = typeof ctx.deckId === 'string' && ctx.deckId ? ctx.deckId : null;
  const view = { el, key: ctx.taskId, adhocId: ctx.adhocId || 'adhoc', deck, localId: deck ? ctx.deckTaskId : null };
  state.views.set(el, view);
  state.byKey.set(view.key, view);
  el.classList.add('todo-ext');
  wire(view);
}

function update(el, ctx, graph) {
  data(graph);
  const view = state.views.get(el);
  if (!view) return;
  // An inline input in this host is mid-edit: replacing its markup would eat the
  // text. The board holds its own re-render while one is focused; this guards
  // any other path that updates the host.
  if (el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
  if (view.deck) {
    const bad = incompatibleDeck(view.deck);
    el.innerHTML = bad
      ? todoIncompatibleHtml(bad.name)
      : todoZoneHtml(todosOf(graphOf(view), view.localId), view.key, state.collapsed.has(view.key), { spawn: false });
    return;
  }
  el.innerHTML = todoZoneHtml(todosOf(state.graph, view.key), view.key, state.collapsed.has(view.key));
}

function unmount(el) {
  const view = state.views.get(el);
  if (!view) return;
  state.views.delete(el);
  if (state.byKey.get(view.key) === view) state.byKey.delete(view.key);
  if (state.drag?.view === view) endDrag();
}

const send = (frame) => state.api.send(frame);
// A frame about a view's todos goes to that view's deck.
const sendFor = (view, frame) => send(view.deck ? { ...frame, deck: view.deck } : frame);
const wireId = (view) => (view.deck ? view.localId : todoKeyToTaskId(view.key, view.adhocId));

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
      sendFor(view, { type: 'todo-delete', taskId: wireId(view), todoId });
      if (optimisticDelete(graphOf(view), bucketOf(view), todoId)) redraw();
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
    state.drag = { view, row, todoId: row.dataset.todoid, placeholder: null, unclaim: state.api.claimDrag(el) };
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
  d.unclaim?.();
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
  if (!d || !view || view.deck !== d.view.deck) return;
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
  if (!d || !view || view.deck !== d.view.deck) return;
  e.preventDefault();
  cell.classList.remove('todo-drop-target');
  const graph = graphOf(view);
  if (view.key === d.view.key) {
    const beforeEl = d.placeholder?.nextElementSibling;
    const beforeId = beforeEl?.classList.contains('todo-row') ? beforeEl.dataset.todoid : null;
    const order = reorderedTodoIds(todosOf(graph, bucketOf(view)).map((td) => td.id), d.todoId, beforeId);
    optimisticReorder(graph, bucketOf(view), order);
    sendFor(view, { type: 'todo-reorder', taskId: wireId(view), order });
  } else if (optimisticMove(graph, d.todoId, bucketOf(d.view), bucketOf(view))) {
    sendFor(view, { type: 'todo-move', todoId: d.todoId, fromTaskId: wireId(d.view), toTaskId: wireId(view) });
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
      sendFor(view, { type: 'todo-add', taskId: wireId(view), text });
      optimisticAdd(graphOf(view), bucketOf(view), text);
    }
    input.blur();
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
      sendFor(view, { type: 'todo-edit', taskId: wireId(view), todoId, text });
      optimisticEdit(graphOf(view), bucketOf(view), todoId, { text });
    }
    input.blur();
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
  const td = todosOf(graphOf(view), bucketOf(view)).find((item) => item.id === todoId);
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
      const graph = graphOf(view);
      const key = Object.keys(graph?.todos || {}).find((bucket) => todosOf(graph, bucket).some((item) => item.id === todoId));
      if (!key) {
        error.textContent = 'This TODO no longer exists.';
        error.hidden = false;
        return;
      }
      sendFor(view, {
        type: 'todo-edit', taskId: todoKeyToTaskId(key, view.adhocId), todoId,
        ...(textChanged ? { text } : {}),
        ...(descriptionChanged ? { description: nextDescription } : {}),
      });
      optimisticEdit(graph, key, todoId, { ...(textChanged ? { text } : {}), ...(descriptionChanged ? { description: nextDescription } : {}) });
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
  // Another deck's task starts its sessions on that deck, not from this board.
  if (view.deck) return;
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
    registrar.register('task.body', { id: 'todos', decks: true, mount, update, unmount, weight });
    registrar.register('task.action', {
      id: 'new-todo',
      decks: true,
      items: (task) => (typeof task.deckId === 'string' && incompatibleDeck(task.deckId)
        ? []
        : [{ label: 'New TODO', icon: CHECK_ICON, run: () => beginAdd(task.id) }]),
    });
  },
};
