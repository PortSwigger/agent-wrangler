// Pure HTML builders for the TODO zone a `task.body` host draws. Strings in,
// strings out, no DOM — so they unit-test in node. The extension is self-contained
// on purpose (its own `esc` and icons rather than imports from the board's
// modules), so it stays loadable from /ext/todos/ whatever the board's layout.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const svg = (body, fill = 'none') =>
  `<svg class="icon" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// Lucide glyphs.
export const CHECK_ICON = svg('<path d="M20 6 9 17l-5-5"/>');
export const PLAY_ICON = svg('<polygon points="6 3 20 12 6 21 6 3"/>');
export const X_ICON = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
export const PENCIL_ICON = svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>');
export const PLUS_ICON = svg('<path d="M5 12h14"/><path d="M12 5v14"/>');
export const MINUS_ICON = svg('<path d="M5 12h14"/>');

export function todoRowHtml(td, key) {
  const spawn = `<button class="todo-spawn" title="Start a session from this TODO"><span class="todo-tick">${CHECK_ICON}</span><span class="todo-play">${PLAY_ICON}</span></button>`;
  const details = `<button class="todo-details${td.description ? ' has-description' : ''}" title="Edit TODO details" aria-label="Edit TODO details">${PENCIL_ICON}</button>`;
  const del = `<button class="todo-del" title="Delete TODO">${X_ICON}</button>`;
  return `<div class="todo-row" data-todoid="${esc(td.id)}" data-todo-key="${esc(key)}" draggable="true">
    ${spawn}<span class="todo-text">${esc(td.text)}</span>${details}${del}
  </div>`;
}

// The zone: a collapsible divider + rows when todos exist and it isn't collapsed,
// plus an empty anchor div the inline add injects its input into (always
// rendered, even collapsed). Open by default — a task's own TODOs are primary
// content the user is expected to see.
//
// The toggle is a `.card-tag` pill — count + a +/- icon, never a rotating
// chevron (a rotating chevron reads as "which way is open?"; +/- doesn't).
export function todoZoneHtml(todos, key, collapsed = false) {
  if (!todos.length) return `<div class="todo-zone" data-todo-key="${esc(key)}"></div>`;
  const toggleIcon = `<span class="todo-toggle-icon">${collapsed ? PLUS_ICON : MINUS_ICON}</span>`;
  const pill = `<button class="card-tag todo-pill" data-todo-key="${esc(key)}" title="${collapsed ? 'Show TODOs' : 'Hide TODOs'}">todo ${todos.length}${toggleIcon}</button>`;
  const divider = `<div class="todo-divider">${pill}</div>`;
  const rows = collapsed ? '' : todos.map((td) => todoRowHtml(td, key)).join('');
  return `${divider}${rows}<div class="todo-zone" data-todo-key="${esc(key)}"></div>`;
}
