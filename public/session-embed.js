// The DOM half of the client `api.mountSession` (1.42.0): lend the board's own
// session panel (#sidebar, with #diff-panel tucked inside it) to an extension's
// view element, and put both back exactly where they were when it is done. A
// leaf with no DOM at import, so the move-and-restore rules are unit-testable
// the way slots.js is; app.js owns what "show a session" and "let go of it"
// mean (selection, resume, terminal) and hands them in as `show` and `release`.
//
// The panel is a singleton with fixed ids, so it is MOVED, not cloned: one
// owner at a time, and every core render path keeps finding its elements by id
// wherever they sit. Three states:
//   home     — no owner; the board uses the panel as it always has.
//   embedded — an owner, its element showing; the panel lives in a
//              `.session-embed` wrapper appended to that element.
//   parked   — an owner whose view is not on screen (another view is current,
//              or it mounted while hidden): the panel is home and the board
//              may use it, and unpark() lends it back when the view returns.
// A later mount into another element takes over; the earlier handle goes inert
// (its sessionId reads null, show and unmount do nothing).
//
// `view` (1.45.0, only 'diff' so far) is the view the NEXT show opens on, held on
// the owner as `o.view` for app.js to apply and clear: one-shot, so the view
// coming back on screen (unpark) reopens wherever the human left it, not on it.
export function createSessionEmbed({ document, parts, show, release }) {
  let owner = null;

  function attach(o) {
    const { sidebar, diffPanel, diffAnchor } = parts();
    o.homes = [sidebar, diffPanel].filter(Boolean).map((node) => ({ node, parent: node.parentNode, next: node.nextSibling }));
    o.wrap = document.createElement('div');
    o.wrap.className = 'session-embed';
    o.el.appendChild(o.wrap);
    o.wrap.appendChild(sidebar);
    // Into the panel's own column, under the header and the extension sections,
    // so the diff takes the chat/terminal's place rather than a pane beside it.
    if (diffPanel) sidebar.insertBefore(diffPanel, diffAnchor && diffAnchor.parentNode === sidebar ? diffAnchor : null);
    o.parked = false;
  }

  // Back in reverse order: #diff-panel first, out of #sidebar, while its old
  // next sibling is still where it was.
  function detach(o) {
    for (const { node, parent, next } of [...(o.homes || [])].reverse()) {
      if (!parent) continue;
      parent.insertBefore(node, next && next.parentNode === parent ? next : null);
    }
    o.homes = null;
    o.wrap?.parentNode?.removeChild(o.wrap);
    o.wrap = null;
    o.parked = true;
  }

  function handleFor(o) {
    const mine = () => owner === o;
    return Object.freeze({
      get sessionId() { return mine() ? o.sessionId : null; },
      show: (sessionId, { view = null } = {}) => {
        if (!mine()) return false;
        o.sessionId = sessionId;
        o.view = view;
        if (!o.parked) show(sessionId, o);
        return true;
      },
      unmount: () => {
        if (!mine()) return;
        drop();
      },
    });
  }

  function drop() {
    const o = owner;
    owner = null;
    if (!o || o.parked) return;
    // Released while still embedded: app.js deselects (closing the diff and the
    // terminal) BEFORE the move, so nothing is left attached to the lent nodes.
    release(o);
    detach(o);
  }

  // `active`: whether the element's view is the one on screen now. Mounting the
  // same element again just switches the session it shows.
  function mount(el, sessionId, { extId = null, onMaximize = null, view = null, active = true } = {}) {
    if (owner && owner.el === el) {
      owner.onMaximize = onMaximize;
      owner.handle.show(sessionId, { view });
      return owner.handle;
    }
    if (owner) drop();
    const o = { el, extId, sessionId, onMaximize, view, maximized: false, parked: true, homes: null, wrap: null };
    o.handle = handleFor(o);
    owner = o;
    if (active) { attach(o); show(sessionId, o); }
    return o.handle;
  }

  function park() {
    if (!owner || owner.parked) return;
    release(owner);
    detach(owner);
  }

  function unpark() {
    if (!owner || !owner.parked) return;
    attach(owner);
    show(owner.sessionId, owner);
  }

  return {
    mount,
    park,
    unpark,
    // The owner whose panel is lent out right now, or null (none, or parked).
    active: () => (owner && !owner.parked ? owner : null),
    owner: () => owner,
    // An extension switched off takes its embed with it.
    dropExtension: (extId) => { if (owner && owner.extId === extId) drop(); },
    // The owner's element left the document without unmount (its view re-drew
    // over it, or went away): bring the panel home rather than lose it.
    reclaimOrphan: () => {
      if (owner && !owner.el.isConnected) { drop(); return true; }
      return false;
    },
  };
}
