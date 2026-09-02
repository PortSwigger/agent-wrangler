// DOM building for the per-session Checklist panel, split out of app.js so the
// two rules that matter here are unit-testable without a browser (mirrors
// chat-dom.js): patch-in-place, and item text via textContent only.
//
// Item text is AGENT-WRITTEN — the launched session adds items through its own
// MCP tools — so it goes in via `textContent`, NEVER `innerHTML`, exactly like
// the diff view and the chat view. There is no escaping helper here on purpose:
// the only way to get text into a row is the property that can't execute it.
//
// Patch-in-place, not innerHTML reassignment: the ~4s graph poll re-renders this
// panel, and rebuilding the list from a string would reset its scroll position
// on every tick while someone is scrolled into a long list, and destroy any row
// element the user is mid-interaction with. So rows are reconciled by id —
// reused, moved, updated or removed — and only genuinely new items allocate an
// element.

// An item the board has just added optimistically, before the server has echoed
// back its real id. The server has never heard of a `tmp_` id, so a toggle,
// rename, delete or reorder aimed at one would be rejected there while applying
// locally — and the next graph would silently revert it. The window is not the
// eyeblink it looks like: a rebuild refreshes every session and scrapes panes,
// so on a busy board the echo is a second or more away. Rows in this state are
// marked `pending` and their controls are inert (styles.css) rather than being
// live buttons whose clicks quietly do nothing.
export function isPendingChecklistId(id) {
  return String(id ?? '').startsWith('tmp_');
}

export function createChecklistDom({ document }) {
  function makeRow(item) {
    const row = document.createElement('div');
    row.className = 'ck-row';
    row.dataset.ckid = item.id;
    row.setAttribute('draggable', String(!isPendingChecklistId(item.id)));
    const check = document.createElement('button');
    check.className = 'ck-check';
    check.setAttribute('type', 'button');
    check.setAttribute('role', 'checkbox');
    check.setAttribute('title', 'Toggle done');
    const text = document.createElement('span');
    text.className = 'ck-text';
    const del = document.createElement('button');
    del.className = 'ck-del';
    del.setAttribute('type', 'button');
    del.setAttribute('title', 'Delete item');
    del.textContent = '×';
    row.appendChild(check);
    row.appendChild(text);
    row.appendChild(del);
    return row;
  }

  // Only write a property that actually changed: a no-op assignment to
  // textContent still replaces the text node, which would drop a selection the
  // user was making inside it on every poll tick.
  function updateRow(row, item) {
    const text = row.querySelector('.ck-text');
    if (text.textContent !== item.text) text.textContent = item.text;
    const done = Boolean(item.done);
    const className = ['ck-row', done ? 'done' : '', isPendingChecklistId(item.id) ? 'pending' : '']
      .filter(Boolean).join(' ');
    if (row.className !== className) row.className = className;
    row.querySelector('.ck-check').setAttribute('aria-checked', String(done));
  }

  return {
    // Reconcile `list`'s children against `items`, in order. `sessionId` is
    // stamped on the list: switching session is the one case where every row is
    // stale, so the list is emptied rather than diffed against another session's
    // ids. Returns the number of rows now rendered.
    patch(list, { sessionId, items = [] }) {
      if (!list) return 0;
      if (list.dataset.sid !== sessionId) {
        while (list.firstChild) list.removeChild(list.firstChild);
        list.dataset.sid = sessionId;
      }
      const existing = new Map();
      for (const row of [...list.children]) existing.set(row.dataset.ckid, row);
      let cursor = 0;
      for (const item of items) {
        let row = existing.get(item.id);
        if (row) existing.delete(item.id);
        else row = makeRow(item);
        updateRow(row, item);
        const at = list.children[cursor];
        // insertBefore(row, row) would pointlessly detach and re-attach the
        // element — enough to blur focus inside it — so only move when the row
        // is not already where it belongs.
        if (at !== row) list.insertBefore(row, at || null);
        cursor++;
      }
      // Anything left in `existing` is an item that has gone.
      for (const row of existing.values()) list.removeChild(row);
      return items.length;
    },
  };
}

// The panel's count chip: "2/5 done", or '' for an empty list (the panel still
// renders with its "+ Add" affordance so a human can see the feature exists on
// this session — an empty panel is not a missing one).
export function checklistCountLabel(items = []) {
  if (!items.length) return '';
  return `${items.filter((i) => i.done).length}/${items.length} done`;
}
