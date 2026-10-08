// The client half of the extensions API: named slots an extension's client
// module (served from /ext/<id>/, see extensions.js) contributes DOM into, and
// the one place the board renders those contributions from. A leaf — no DOM at
// import; `document` is injected so the reconciliation rules are unit-testable
// the way chat-dom.js is.
//
// A new slot needs BOTH an entry here AND a host in app.js that mounts it —
// SLOT_NAMES is the registry, and register() refuses a name that isn't in it so
// a typo in an extension fails at load rather than rendering nowhere. The two
// panel slots have ONE host each and go through mountInto/update; `card.pill`
// has one host PER CARD (`.card-meta-ext`, cards.js) and goes through
// syncHosts, which is the whole reason mounts are keyed by host below.
//
// `view` is the third shape: a whole top-level view beside the board and
// Search, one OWN host per contribution (app.js renderExtViews creates it, and
// the rail button and #view= hash route that reach it, from `label`/`icon`).
// It goes through syncHosts too, but with each entry carrying `only` so a
// contribution lands in its own host and not in every view's — see sync().
// A view may also carry `badge()`, the one thing it cannot draw itself: the
// rail button is the board's chrome, so core owns the element and the
// extension owns only the number — see reportBadges().
//
// Slots are the OUTBOUND half (DOM out, `send` back to the control socket). The
// INBOUND half is `onMessage`/`dispatchMessage`: a server-side `host.broadcast`
// puts an `{type:'ext:<id>', …}` frame on the control socket, app.js's ws ladder
// hands every `ext:`-prefixed frame to dispatchMessage, and it reaches only the
// listeners that extension's own module subscribed. Without it such a frame fell
// off the end of app.js's `else if` ladder and was silently dropped, so a server
// half had no way to tell its own browser half anything — see dispatchMessage.
//
// `dispatch.field` is the fourth shape and the first slot that shapes a CORE
// form: three anchor hosts inside #modal's #m-dispatch-fields (app.js
// syncDispatchExtFields), a contribution addressing one of them with `at`, and
// an optional `hides` veto over named core rows — a fixed list, or a function
// of the form's current draft so the veto can follow another field (say, the
// runtime choice). Its entries carry `at` alongside `only` — see sync(). A
// contribution may also return `ext(el, ctx)`, data for its OWN server half,
// which rides the dispatch frame as `ext.<extId>` — see dispatchFields() — and
// `open(el, ctx)`, called once per modal open with its own saved slice — see
// openDispatchFields().
//
// `card.action` and `card.cost` are VALUE slots: no host, no mount. The board
// asks them for values while it draws core chrome — menu items for a card's
// right-click and Actions menus (menuItems()), a spend ceiling for the card's
// cost tag (costCeiling()) — because that chrome is core markup an extension
// could never mount into.
//
// `task.action` is `card.action`'s mirror for a task tile: menu items for the
// tile's right-click menu (taskMenuItems()). Its subject is the TILE, not a
// session — `{ id, name, adhoc }`, the no-task tile being `adhoc` with the
// reserved id — which is also what `api.minimiseTask` takes.
//
// `link.chip` (1.18.0) is a VALUE slot too: the chip a board link of the
// extension's own type draws (linkChip()). `chip(link, graph, api)` answers
// `{ label, href?, icon? }` for its type and null for any other; core draws the
// markup, so `label` and `href` stay text and `icon` is held to a strict SVG
// subset. Core draws `pr` itself; a link nothing answers for draws no chip.
//
// `settings.panel` (1.14.0) is a single-host slot inside an extension's own
// settings dialog (app.js openExtSettings): only the OWNING extension's
// contributions mount there (mountInto's `onlyExt`), above the manifest rows.
// A contribution may carry `save(el)` (may return a Promise), awaited when the
// dialog's Done is pressed — see savePanels(); Escape closes without it.
//
// `task.body` (1.15.0) has one host PER TASK TILE, the Unassigned tile included
// (app.js mountTaskBodies, cards.js taskBodyHostHtml), reconciled with syncHosts
// like `card.pill`. Its per-host subject is `{ taskId, adhocId, container }` —
// `taskId` is the tile's key (the reserved `adhocId` for Unassigned), `container`
// the host element — handed to `mount(el, api, ctx)` and `update(el, ctx, graph)`.
// A contribution may carry `weight(taskId, graph)`: the px of tile height its
// content wants, summed by taskBodyWeight() into tile sizing so a tile grows for
// it. It must be cheap and synchronous; a throwing weight counts as 0.
export const SLOT_NAMES = ['panel.section', 'panel.metaChip', 'card.pill', 'view', 'dispatch.field', 'card.action', 'card.cost', 'task.action', 'settings.panel', 'task.body', 'link.chip'];


// The capability a client-only `api.cards` call is gated on (server/extensions
// CLIENT_CAPABILITIES) — carried on the announcement and graph.extensions as
// `requires`, read back through requiresFor.
export const HIDE_CHIPS_CAPABILITY = 'cards:hideChips';

// The value slots and the one function each contribution must carry in place
// of mount().
const VALUE_SLOTS = { 'card.action': 'items', 'card.cost': 'cost', 'task.action': 'items', 'link.chip': 'chip' };

// The only icon markup a `link.chip` may carry: one <svg> of <path>s with plain
// presentation attributes. Anything else (scripts, handlers, urls, foreign
// elements) is dropped to no icon rather than interpolated into the board.
const SAFE_ICON_RE = /^<svg(?:\s+[A-Za-z-]+="[^"<>]*")*\s*>(?:<path(?:\s+[A-Za-z-]+="[^"<>]*")*\s*\/>)+<\/svg>$/;
export function safeChipIcon(icon) {
  return typeof icon === 'string' && SAFE_ICON_RE.test(icon) && !/\son[a-z]+\s*=|javascript:|url\(/i.test(icon) ? icon : '';
}

// Where inside the dispatch modal a `dispatch.field` contribution may land.
// `top` is above the folder field, `model` is beside the model selector, and
// `advanced` is the last child of the Advanced options body.
export const DISPATCH_ANCHORS = ['top', 'model', 'advanced'];

// Slots whose contribution must carry more than mount() — a view has no host
// until the board has something to label its rail button with, and a
// dispatch.field has no sensible DEFAULT place in a form: a control that lands
// in the wrong block is worse than one that fails to register, so `at` is
// required and checked against DISPATCH_ANCHORS below.
const REQUIRED_FIELDS = { view: ['label'], 'dispatch.field': ['at'] };

// Every contribution owns exactly ONE element per host element, created here and
// handed to mount(el, api) once — `c.mounts` is that host -> element map. A
// panel slot only ever holds one entry in it; a card slot holds one per card on
// screen, and each is updated with ITS OWN card's session (see syncHosts), never
// the selected one.
//
// "Mount-once" is per HOST ELEMENT identity, and a host that is gone is a
// teardown: renderPanel rebuilds its chips row via innerHTML on every render, so
// a fresh row is a fresh host and the chip is mounted again into it (the
// previous element died with the old row; unmount is told). A host that is the
// same element across renders — #panel-sections — mounts once for the life of
// the page. Which hosts are gone is decided by the CALLER's host set, never by
// probing the DOM: the caller has just rendered, so it knows, and `isConnected`
// would make the reconciliation untestable against a plain element stub.
//
// An extension must never blank the board: mount/update/unmount are each run
// under try/catch and a throwing contribution is REMOVED (every element it has,
// in every host, the error reported) while every other contribution carries on —
// the same lesson as module-syntax.test.js's blank-dashboard incident, applied
// at run time to code the core does not own.
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function createSlots({ document, storage, onError = (...a) => console.error(...a), handlerTypesFor = () => [], hideDispatchFieldsFor = () => [], requiresFor = () => [], onChipsChanged = () => {}, onExtensionRemoved = () => {}, coreChips = [], version = null }) {
  const bySlot = new Map(SLOT_NAMES.map((n) => [n, []]));
  // extId -> Set<chip key>: each extension's api.cards.hideChips() choice. The
  // board hides the UNION (hiddenChips()); a removed extension's set goes with
  // it (removeExtension), so disable/uninstall brings its hidden chips back.
  const hiddenByExt = new Map();
  // extId -> Set<fn>: api.settings.onChange subscribers, fed by settingsChanged().
  const settingsListeners = new Map();
  // Sample-card failures already reported, `extId:id`, so a pill that throws on
  // the fake session prints once rather than once per render.
  const sampleReported = new Set();
  const apis = new Map();
  // extId -> Set<fn>: the INBOUND half of the per-extension api, the mirror of
  // the bound `send` below. A server-side `host.broadcast` forces its frame's
  // type to `ext:<id>` (host-api/v1.js), and dispatchMessage() below is the only
  // thing that turns such a frame into a call — keyed on the id parsed out of
  // that type, so one extension can never hear another's frames however the
  // payload is shaped.
  const listeners = new Map();
  // `extId:name` pairs already reported by hiddenDispatchFields(), so an
  // undeclared veto prints once for the life of the page rather than once per
  // recompute.
  const hideReported = new Set();
  // Colliding `card.cost` pairs already reported by costCeiling().
  const costReported = new Set();
  // `extId:id` of task.body contributions whose weight() already threw.
  const weightReported = new Set();

  // Subscribe `fn` to this extension's own `ext:<extId>` frames. Returns an
  // unsubscribe function, which is what a contribution that subscribes inside
  // mount() must call from unmount(): `card.pill` has one host PER CARD, so a
  // contribution subscribing per mount would subscribe once per card on screen
  // and hear every frame that many times. Subscribing from the module's
  // register() (see forExtension) has no such hazard and is the normal place.
  function subscribe(extId, fn) {
    if (typeof fn !== 'function') {
      onError(`[ext:${extId}] onMessage needs a function`);
      return () => {};
    }
    if (!listeners.has(extId)) listeners.set(extId, new Set());
    const set = listeners.get(extId);
    set.add(fn);
    return () => { set.delete(fn); };
  }

  function slotList(slotName) {
    const list = bySlot.get(slotName);
    if (!list) throw new Error(`Unknown slot "${slotName}" (known: ${SLOT_NAMES.join(', ')})`);
    return list;
  }

  function drop(slotName, c) {
    const list = slotList(slotName);
    const at = list.indexOf(c);
    if (at >= 0) list.splice(at, 1);
    teardown(c);
  }

  function teardownAt(c, host) {
    const el = c.mounts.get(host);
    c.mounts.delete(host);
    if (!el) return;
    try { c.unmount?.(el); } catch (err) { onError(`[ext:${c.extId}] ${c.id} unmount failed`, err); }
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  function teardown(c) {
    for (const host of [...c.mounts.keys()]) teardownAt(c, host);
  }

  // The per-extension `api` — the VERSIONED client half of the host façade, and
  // the browser mirror of its forced-value rule. It is the base api the caller
  // hands in, plus:
  //   storage — namespaced `ext.<id>.` so two extensions cannot collide on a
  //             localStorage key (`raw()` still escapes it, see below).
  //   send    — BOUND to this extension's OWN registered control types. A frame
  //             whose type it did not register is DROPPED and reported, never
  //             sent: otherwise an extension's browser half could drive another
  //             extension's — or the core's — control handlers, which is exactly
  //             what the server-side façade stops it doing over MCP.
  //   version — the host API the server serves, so a client module can check what
  //             it is talking to the way its manifest's range does server-side.
  //   onMessage — the INBOUND mirror of `send`, bound to this extension's OWN
  //             `ext:<id>` frames. See subscribe() above and dispatchMessage()
  //             below; the same function is on the registrar forExtension()
  //             returns, which is where a module-level subscription belongs.
  //   openSession — the one piece of board NAVIGATION an extension gets: show
  //             this card, resuming it first if it is dormant (1.8.0). The base
  //             api implements it (app.js) because it drives the view, the
  //             selection and the core `resume` frame — none of which `send`
  //             may reach, since it is bound to the extension's own types. A
  //             non-id argument is reported and dropped, like a refused send.
  //   minimiseTask — the tile-level counterpart (1.11.0): tuck this task's tile
  //             into the tray, exactly as its header's Minimise does. Same
  //             reason it lives on the base api — the minimised set is board
  //             view state (app.js), not a control frame — and the same
  //             refusal for a non-id argument. The base api returns whether the
  //             tile was actually minimised (an unknown id, or the last visible
  //             tile, is a no-op), and that answer is passed straight back.
  //   settings — this extension's OWN current setting values (1.13.0), a fresh
  //             copy per call so a caller cannot write through into board
  //             state. Read live, never captured, so a dispatch.field can
  //             prefill from what Settings holds right now. Unset keys are
  //             absent, exactly as `host.settings` reads them server-side.
  //   ui      — rendering helpers the board owns (frozen). `markdownPreview(md)`
  //             returns sanitised HTML for a markdown string, from the same
  //             renderer as the chat view and file preview; a non-string is
  //             reported and gives ''. Style the result with `.chat-prose` or
  //             the extension's own CSS.
  //             `notify({ id, title, body, actions, sessionId })` (1.23.0; sessionId 1.24.0) raises a card
  //             in the bottom-right stack (public/notifications.js) and
  //             resolves with the clicked action's id, or null when it is
  //             closed or withdrawn; `withdraw(id)` takes one down. The owner
  //             is forced to this extension, and its cards go when it does.
//             A `sessionId` has the board print that session's task name
//             under the title.
  // `handlerTypesFor` defaults to allowing NOTHING: a board that has not yet been
  // told an extension's types (no announcement, no graph) must fail closed and
  // report rather than forward blind.
  // Built once per extension, so a contribution can compare it by identity
  // across renders — the type list is read at SEND time, not captured here,
  // since the announcement can arrive after a contribution has mounted.
  function apiFor(extId, baseApi) {
    if (!apis.has(extId)) {
      apis.set(extId, {
        ...baseApi,
        // Resolved HERE rather than at createSlots time: the server announces it,
        // and an api is only ever built once a module has loaded — which cannot
        // happen before that announcement. A function is accepted so the caller
        // need not have the value at construction.
        version: typeof version === 'function' ? version() : version,
        storage: namespacedStorage(`ext.${extId}.`, storage),
        send: (frame) => {
          const type = frame && typeof frame === 'object' ? frame.type : null;
          const allowed = handlerTypesFor(extId) || [];
          if (typeof type !== 'string' || !allowed.includes(type)) {
            onError(`[ext:${extId}] send refused: "${type}" is not one of this extension's control handlers (${allowed.join(', ') || 'none'})`);
            return;
          }
          baseApi.send?.(frame);
        },
        onMessage: (fn) => subscribe(extId, fn),
        openSession: (sessionId) => {
          if (typeof sessionId !== 'string' || !sessionId) {
            onError(`[ext:${extId}] openSession refused: expected a session id, got ${JSON.stringify(sessionId)}`);
            return;
          }
          baseApi.openSession?.(sessionId);
        },
        minimiseTask: (taskId) => {
          if (typeof taskId !== 'string' || !taskId) {
            onError(`[ext:${extId}] minimiseTask refused: expected a task id, got ${JSON.stringify(taskId)}`);
            return false;
          }
          return Boolean(baseApi.minimiseTask?.(taskId));
        },
        ui: Object.freeze({
          markdownPreview: (md) => {
            if (typeof md !== 'string') {
              onError(`[ext:${extId}] ui.markdownPreview refused: expected a string, got ${typeof md}`);
              return '';
            }
            return String(baseApi.markdownPreview?.(md) ?? '');
          },
          notify: (opts) => {
            const o = isPlainObject(opts) ? opts : {};
            const actions = Array.isArray(o.actions) ? o.actions : [];
            const bad = typeof o.id !== 'string' || !o.id ? 'id must be a non-empty string'
              : typeof o.title !== 'string' || !o.title ? 'title must be a non-empty string'
                : o.body != null && typeof o.body !== 'string' ? 'body must be a string'
                  : o.sessionId != null && typeof o.sessionId !== 'string' ? 'sessionId must be a string'
                  : actions.some((a) => !isPlainObject(a) || typeof a.id !== 'string' || typeof a.label !== 'string') ? 'each action needs a string id and label'
                    : null;
            if (bad) {
              onError(`[ext:${extId}] ui.notify refused: ${bad}`);
              return Promise.resolve(null);
            }
            if (typeof baseApi.notify !== 'function') return Promise.resolve(null);
            return Promise.resolve(baseApi.notify(extId, {
              id: o.id, title: o.title, body: o.body || '', sessionId: o.sessionId || null,
              actions: actions.map((a) => ({ id: a.id, label: a.label, primary: Boolean(a.primary) })),
            }));
          },
          withdraw: (id) => {
            if (typeof id === 'string' && id) baseApi.withdrawNotification?.(extId, id);
          },
        }),
        settings: settingsApi(extId, baseApi),
        // Mark `el` as carrying an extension-owned drag: the board treats any
        // [data-ext-drag] element as "a drag is in progress" and holds its
        // background re-renders (app.js gridEditing) so the gesture is not torn
        // down. Returns the unclaim function; call it on drop/dragend.
        claimDrag: (el) => claimDrag(extId, el),
        // Open the dispatch modal (1.15.0) and resolve with the `dispatched`
        // ack, or null when it is cancelled. See app.js openDispatchAcked for
        // the concurrency rule.
        openDispatch: (opts = {}) => {
          if (typeof baseApi.openDispatchAcked !== 'function') return Promise.reject(new Error(`[ext:${extId}] openDispatch is not available`));
          const o = opts && typeof opts === 'object' ? opts : {};
          if (o.taskId != null && (typeof o.taskId !== 'string' || !o.taskId)) return Promise.reject(new Error(`[ext:${extId}] openDispatch taskId must be a task id string or null`));
          if (o.intent != null && typeof o.intent !== 'string') return Promise.reject(new Error(`[ext:${extId}] openDispatch intent must be a string`));
          return Promise.resolve(baseApi.openDispatchAcked({ taskId: o.taskId ?? null, intent: o.intent || '', lockTask: Boolean(o.lockTask) }));
        },
        // Ask the board to re-render (and so re-size its tiles): the
        // task.body counterpart of requestPanelRender.
        requestBoardRender: () => { baseApi.requestBoardRender?.(); },
        // Always present (the api is built once), but every call throws unless
        // the manifest's `requires` granted cards:hideChips — see cardsApi.
        cards: cardsApi(extId, baseApi),
      });
    }
    return apis.get(extId);
  }

  function unionHidden() {
    const out = new Set();
    for (const set of hiddenByExt.values()) for (const k of set) out.add(k);
    return out;
  }

  function chipsChanged() {
    try { onChipsChanged(); } catch (err) { onError('[ext] chipsChanged failed', err); }
  }

  // A throw on a SAMPLE host (the settings dialog's preview card, whose session
  // is made up) must not cost the contribution its place on the real board: it
  // is reported once and skipped at that host only.
  function sampleFailed(c, host, what, err) {
    teardownAt(c, host);
    const key = `${c.extId}:${c.id}`;
    if (sampleReported.has(key)) return;
    sampleReported.add(key);
    onError(`[ext:${c.extId}] ${c.id} ${what} failed on the sample card — skipped there`, err);
  }

  // extId -> Set<element> currently marked [data-ext-drag], so removing an
  // extension (disable, uninstall, failed load) cannot leave the board frozen.
  const dragClaims = new Map();
  function claimDrag(extId, el) {
    if (!el || typeof el.setAttribute !== 'function') {
      onError(`[ext:${extId}] claimDrag needs an element, got ${typeof el}`);
      return () => {};
    }
    el.setAttribute('data-ext-drag', extId);
    if (!dragClaims.has(extId)) dragClaims.set(extId, new Set());
    dragClaims.get(extId).add(el);
    return () => {
      dragClaims.get(extId)?.delete(el);
      el.removeAttribute?.('data-ext-drag');
    };
  }

  function cardsApi(extId, baseApi) {
    const gate = (name) => {
      if (!(requiresFor(extId) || []).includes(HIDE_CHIPS_CAPABILITY)) {
        throw new Error(`[ext:${extId}] cards.${name} requires the ${HIDE_CHIPS_CAPABILITY} capability`);
      }
    };
    return Object.freeze({
      chips: () => {
        gate('chips');
        return [
          ...coreChips.map((c) => ({ key: c.key, label: c.label, source: 'core' })),
          ...chipContributions().map((c) => ({ key: c.key, label: c.label, source: c.extId })),
        ];
      },
      hideChips: (keys) => {
        gate('hideChips');
        if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
          onError(`[ext:${extId}] cards.hideChips needs an array of chip keys, got ${JSON.stringify(keys)}`);
          return;
        }
        hiddenByExt.set(extId, new Set(keys));
        chipsChanged();
      },
      renderSample: (el, { hidden = [] } = {}) => {
        gate('renderSample');
        const keys = Array.isArray(hidden) ? hidden.filter((k) => typeof k === 'string') : [];
        return baseApi.renderSampleCard?.(el, extId, new Set(keys));
      },
    });
  }

  function settingsApi(extId, baseApi) {
    const read = () => ({ ...(baseApi.settingsFor?.(extId) || {}) });
    return Object.assign(read, {
      // The id is FORCED from the closed-over extId, so an extension can only
      // ever write its own settings; the server validates against its defs.
      set: (key, value) => {
        if (typeof key !== 'string' || !key) return Promise.reject(new Error(`[ext:${extId}] settings.set needs a setting key`));
        if (typeof baseApi.setExtSetting !== 'function') return Promise.reject(new Error(`[ext:${extId}] settings.set is not available`));
        return Promise.resolve(baseApi.setExtSetting(extId, key, value));
      },
      onChange: (fn) => {
        if (typeof fn !== 'function') {
          onError(`[ext:${extId}] settings.onChange needs a function`);
          return () => {};
        }
        if (!settingsListeners.has(extId)) settingsListeners.set(extId, new Set());
        const set = settingsListeners.get(extId);
        set.add(fn);
        return () => { set.delete(fn); };
      },
    });
  }

  function chipContributions() {
    return [...slotList('card.pill'), ...slotList('link.chip')].map((c) => ({
      key: `${c.extId}:${c.id}`,
      label: typeof c.label === 'string' && c.label ? c.label : c.id,
      extId: c.extId,
    }));
  }

  // Give `c` an element inside `host`, mounting only if it has none there yet.
  // Returns false when the contribution was dropped (its mount threw), which is
  // the caller's signal to stop feeding it hosts. `sample` hosts never drop.
  function ensure(slotName, c, host, baseApi, sample = false, subject = null) {
    const existing = c.mounts.get(host);
    if (existing && existing.parentNode === host) return true;
    if (existing) teardownAt(c, host);
    const el = document.createElement('div');
    el.className = 'ext-slot';
    el.dataset.ext = c.extId;
    el.dataset.contrib = c.id;
    if (slotName === 'card.pill') el.dataset.chip = `${c.extId}:${c.id}`;
    host.appendChild(el);
    c.mounts.set(host, el);
    try {
      if (slotName === 'task.body') c.mount(el, apiFor(c.extId, baseApi), subject);
      else c.mount(el, apiFor(c.extId, baseApi));
    } catch (err) {
      if (sample) { sampleFailed(c, host, 'mount', err); return false; }
      onError(`[ext:${c.extId}] ${c.id} mount failed — contribution removed`, err);
      drop(slotName, c);
      return false;
    }
    return true;
  }

  function updateAt(slotName, c, host, session, graph, sample = false) {
    const el = c.mounts.get(host);
    if (!el || typeof c.update !== 'function') return true;
    try {
      c.update(el, session, graph);
    } catch (err) {
      if (sample) { sampleFailed(c, host, 'update', err); return false; }
      onError(`[ext:${c.extId}] ${c.id} update failed — contribution removed`, err);
      drop(slotName, c);
      return false;
    }
    return true;
  }

  // What `badge()` returned, as something the board can draw. Anything that is
  // not a positive whole count draws nothing: absent-or-falsy is the documented
  // "no badge", and a NaN, negative or fractional value is an extension bug
  // that must NOT print a line — this runs on the ~4s view tick, so a report
  // here would be a report per tick, the same reason dispatchMessage says
  // nothing about a frame nobody is listening for.
  function badgeCount(n) {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  // Ask every DRAWN contribution to this slot what its badge should say, and
  // hand each answer to `onBadge({extId, id, count})`. Only `view` has a caller
  // that asks (app.js updateExtViews), because the rail button is the only
  // chrome core draws on a contribution's behalf — a count on it is the one
  // thing an extension that owns a whole pane still cannot put there itself,
  // short of smuggling markup into `icon` and positioning it against a button
  // core owns.
  //
  // Run AFTER mount and update, so a badge reads whatever the update it shares
  // a tick with just settled, and under the same try/catch-and-drop rule: a
  // throwing badge removes the contribution exactly as a throwing update does,
  // because this too runs inside the board's own render.
  //
  // A contribution with no `badge`, one with no element (nothing drawn is
  // nothing to count for) and one that has just been dropped all report
  // NOTHING rather than a zero. The caller clears whatever it did not hear
  // about, which is one rule covering all three.
  function reportBadges(slotName, graph, onBadge) {
    for (const c of [...slotList(slotName)]) {
      if (typeof c.badge !== 'function' || c.mounts.size === 0) continue;
      let n;
      try {
        n = c.badge(graph);
      } catch (err) {
        onError(`[ext:${c.extId}] ${c.id} badge failed — contribution removed`, err);
        drop(slotName, c);
        continue;
      }
      onBadge({ extId: c.extId, id: c.id, count: badgeCount(n) });
    }
  }

  // Reconcile a slot against the hosts it should be in RIGHT NOW: mount into
  // each, tear down anything left in a host that isn't listed, and (when the
  // caller passed sessions) update each element with its own host's session.
  //
  // An entry may name ONE contribution via `only: {extId, id}`, which is what
  // the `view` slot uses: every other slot's host holds every contribution
  // (each card's chip row shows all the pills), but a view's host IS one
  // contribution's view and must hold nothing else. The keep-set is therefore
  // computed per contribution — an unaddressed host is not a host that
  // contribution should be torn out of, it is one that was never its.
  //
  // `at` is the second, INDEPENDENT entry filter and the group-shaped version
  // of exactly that argument: `only` names ONE contribution's own host, `at`
  // names a GROUP of contributions' shared anchor (the dispatch modal's three
  // anchor hosts, each holding every contribution addressed to it). The
  // conclusion is the same in both shapes — a host this contribution was not
  // addressed to is not one to tear it out of, it was never its. They stay two
  // filters; folding `at` into `only` would lose the group case.
  //
  // `ext` is a third filter (settings.panel): the host holds only that
  // extension's contributions. And for `card.pill` the chip veto is one more:
  // a contribution whose key is in the entry's `hidden` set (default: the union
  // of every extension's hideChips) is simply not in that host — torn down if
  // it was — while staying registered and live everywhere else. Board and
  // sample hosts MUST arrive in one call: the keep-set is the whole slot's.
  function sync(slotName, entries, baseApi, withUpdate) {
    const union = slotName === 'card.pill' ? unionHidden() : null;
    for (const c of [...slotList(slotName)]) {
      const key = `${c.extId}:${c.id}`;
      const mine = entries.filter((e) =>
        (!e.only || (e.only.extId === c.extId && e.only.id === c.id))
        && (!e.at || e.at === c.at)
        && (!e.ext || e.ext === c.extId)
        && !(union && (e.hidden || union).has(key)));
      const keep = new Set(mine.map((e) => e.host));
      for (const host of [...c.mounts.keys()]) if (!keep.has(host)) teardownAt(c, host);
      for (const { host, session, graph, sample } of mine) {
        if (!ensure(slotName, c, host, baseApi, sample, session)) { if (sample) continue; break; }
        if (withUpdate && !updateAt(slotName, c, host, session, graph, sample)) { if (sample) continue; break; }
      }
    }
  }

  // The body of both menu value slots: every contribution's `items(subject,
  // graph, api)` in registration order, normalised to the menu's item shape. A
  // throwing `items()` removes the contribution; a malformed item is skipped and
  // reported; `run` is wrapped so a throw never escapes into the menu's click
  // handler.
  function valueMenuItems(slotName, subject, graph, baseApi) {
    const out = [];
    for (const c of [...slotList(slotName)]) {
      let items;
      try {
        items = c.items(subject, graph, apiFor(c.extId, baseApi));
      } catch (err) {
        onError(`[ext:${c.extId}] ${c.id} items failed — contribution removed`, err);
        drop(slotName, c);
        continue;
      }
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it.label !== 'string' || !it.label || typeof it.run !== 'function') {
          onError(`[ext:${c.extId}] ${c.id} returned a menu item without a label and run()`);
          continue;
        }
        out.push({
          extId: c.extId,
          label: it.label,
          hint: typeof it.hint === 'string' ? it.hint : '',
          icon: typeof it.icon === 'string' ? it.icon : '',
          danger: Boolean(it.danger),
          run: (e) => { try { it.run(e); } catch (err) { onError(`[ext:${c.extId}] ${c.id} menu item "${it.label}" failed`, err); } },
        });
      }
    }
    return out;
  }

  return {
    register(slotName, extId, contribution) {
      const list = slotList(slotName);
      if (!contribution || typeof contribution.id !== 'string' || !contribution.id) throw new Error(`[ext:${extId}] contribution to ${slotName} has no id`);
      const valueFn = VALUE_SLOTS[slotName];
      if (valueFn) {
        if (typeof contribution[valueFn] !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} in ${slotName} has no ${valueFn} function`);
      } else if (typeof contribution.mount !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} has no mount function`);
      for (const field of REQUIRED_FIELDS[slotName] || []) {
        if (typeof contribution[field] !== 'string' || !contribution[field]) throw new Error(`[ext:${extId}] ${contribution.id} in ${slotName} has no ${field}`);
      }
      // `badge` is optional, but a non-function one is a TYPO, not a choice:
      // reportBadges would skip it in silence and the author would be left
      // looking at a rail button that never says anything. Same reason
      // slotList refuses an unknown slot name — fail at load, not nowhere.
      if (contribution.badge != null && typeof contribution.badge !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} badge must be a function`);
      if (contribution.weight != null && typeof contribution.weight !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} weight must be a function`);
      if (contribution.ext != null && typeof contribution.ext !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} ext must be a function`);
      if (contribution.open != null && typeof contribution.open !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} open must be a function`);
      // Dispatch-modal specifics. Both THROW for the same reason: a typo must
      // fail at load, not render nowhere.
      if (slotName === 'dispatch.field') {
        if (!DISPATCH_ANCHORS.includes(contribution.at)) throw new Error(`[ext:${extId}] ${contribution.id} has an unknown dispatch anchor "${contribution.at}" (known: ${DISPATCH_ANCHORS.join(', ')})`);
        // A function `hides` can only be checked when it runs — see
        // hiddenDispatchFields() for what a bad return costs it.
        if (contribution.hides != null && typeof contribution.hides !== 'function'
          && (!Array.isArray(contribution.hides) || contribution.hides.some((f) => typeof f !== 'string' || !f))) {
          throw new Error(`[ext:${extId}] ${contribution.id} hides must be an array of dispatch field names or a function (draft) => names`);
        }
      }
      if (slotName === 'card.pill' && contribution.label != null && typeof contribution.label !== 'string') throw new Error(`[ext:${extId}] ${contribution.id} label must be a string`);
      if (slotName === 'settings.panel' && contribution.save != null && typeof contribution.save !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} save must be a function`);
      if (list.some((c) => c.extId === extId && c.id === contribution.id)) throw new Error(`[ext:${extId}] ${contribution.id} is already registered in ${slotName}`);
      list.push({ ...contribution, extId, slotName, mounts: new Map() });
    },

    // A registrar bound to one extension id, which is what an extension module's
    // register() receives — so a module can only ever register under its own id.
    // `onMessage` is here as well as on the api because a subscription needs no
    // host: a module with no contribution at all (or one whose frames are not
    // any single contribution's business) has nowhere else to ask for one, and a
    // subscription taken here is taken exactly once per module load.
    // `api` (1.14.0) is the SAME object apiFor() gives contributions (built once
    // per extension, so identity holds), so a module can call e.g.
    // api.cards.hideChips or api.settings.onChange from register() with no
    // contribution mounted. Same capability gates; removeExtension clears
    // whatever it took. A getter, so a registrar that never touches it builds
    // nothing. `baseApi` is app.js's extApi, passed through extensions.js.
    forExtension(extId, baseApi = {}) {
      return {
        register: (slotName, contribution) => this.register(slotName, extId, contribution),
        onMessage: (fn) => subscribe(extId, fn),
        get api() { return apiFor(extId, baseApi); },
      };
    },

    removeExtension(extId) {
      for (const [, list] of bySlot) {
        for (const c of [...list]) if (c.extId === extId) { list.splice(list.indexOf(c), 1); teardown(c); }
      }
      apis.delete(extId);
      for (const el of dragClaims.get(extId) || []) el.removeAttribute?.('data-ext-drag');
      dragClaims.delete(extId);
      // A disabled, uninstalled or failed-to-load extension must stop HEARING
      // too, not just stop drawing: extensions.js calls this on unload, so the
      // subscription dies with the module that took it and a later re-enable
      // re-imports and re-subscribes.
      listeners.delete(extId);
      settingsListeners.delete(extId);
      if (hiddenByExt.delete(extId)) chipsChanged();
      try { onExtensionRemoved(extId); } catch (err) { onError(`[ext:${extId}] cleanup failed`, err); }
    },

    // The union of every live extension's hideChips() keys, as a fresh Set —
    // what app.js's cardCtx hands sessionCardHtml as ctx.hiddenChips.
    hiddenChips() {
      return unionHidden();
    },

    // Every live `card.pill` contribution as `{ key, label, extId }`, in
    // registration order; `label` falls back to the contribution id.
    chipContributions() {
      return chipContributions();
    },

    // app.js calls this when a graph carries different settingValues for
    // `extId` than the previous one. Each listener gets its own copy; a throwing
    // listener is reported and KEPT, the same rule as dispatchMessage.
    settingsChanged(extId, values) {
      const set = settingsListeners.get(extId);
      if (!set) return 0;
      let called = 0;
      for (const fn of [...set]) {
        called += 1;
        try { fn({ ...(values || {}) }); } catch (err) { onError(`[ext:${extId}] settings.onChange listener failed`, err); }
      }
      return called;
    },

    // Tear every contribution out of one host (the settings dialog closing), so
    // each unmount runs.
    unmountHost(slotName, hostEl) {
      for (const c of [...slotList(slotName)]) teardownAt(c, hostEl);
    },

    // Await `save(el)` of every contribution mounted in `hostEl`, in
    // registration order. A rejection (or throw) propagates, which is the
    // dialog's cue to stay open — the extension shows its own error.
    async savePanels(hostEl, slotName = 'settings.panel') {
      for (const c of [...slotList(slotName)]) {
        const el = c.mounts.get(hostEl);
        if (el && typeof c.save === 'function') await c.save(el);
      }
    },

    // Route one server frame to the extension it names. `frame.type` is
    // `ext:<extId>`, FORCED server-side from the closed-over extension id
    // (host-api/v1.js `boardBroadcast`), so the id in the type is the only
    // address there is and nothing in the payload can redirect it.
    //
    // FAILS CLOSED, the same way `send` does: the only route to a listener is a
    // subscription this extension's own module took, so a board that has heard
    // nothing about `<extId>` — never announced, not enabled, module never
    // loaded, already unloaded — has no set to dispatch into and the frame goes
    // nowhere. Unlike `send` that is NOT reported: an extension with no client
    // half, or one that simply does not listen, is an ordinary state and a
    // broadcast per tick would print a line per tick. A MALFORMED type is
    // reported, because that one can only be a core bug.
    //
    // Each listener gets its own shallow COPY of the frame, `type` included, so
    // one listener cannot reshape what the next one — or a later frame's — sees.
    // A throwing listener is reported and KEPT, which is deliberately unlike a
    // throwing contribution: mount/update run inside the board's own render and
    // a throw there is what the removal rule protects the render from, while a
    // listener runs in its own loop and can hurt nothing but itself. Deafening
    // an extension for the life of the page over one bad frame is the worse
    // failure. Returns how many listeners were called.
    dispatchMessage(frame) {
      const type = frame && typeof frame === 'object' ? frame.type : null;
      const extId = typeof type === 'string' && type.startsWith('ext:') ? type.slice(4) : '';
      if (!extId) {
        onError(`[ext] dispatchMessage: "${type}" is not an ext:<id> frame`);
        return 0;
      }
      const set = listeners.get(extId);
      if (!set || set.size === 0) return 0;
      let called = 0;
      for (const fn of [...set]) {
        called += 1;
        try { fn({ ...frame }); } catch (err) { onError(`[ext:${extId}] onMessage listener failed`, err); }
      }
      return called;
    },

    // Mount every contribution to `slotName` into `hostEl`, which for a
    // single-host slot means this host is the ONLY one: an element left in a
    // previous host (an innerHTML-rebuilt chips row) is torn down. Returns the
    // number of contributions now mounted there.
    // `onlyExt` restricts the host to one extension's contributions (the
    // settings.panel dialog, which belongs to exactly one extension).
    mountInto(slotName, hostEl, baseApi = {}, { onlyExt = null } = {}) {
      if (!hostEl) return 0;
      sync(slotName, [{ host: hostEl, ext: onlyExt }], baseApi, false);
      return slotList(slotName).filter((c) => c.mounts.has(hostEl)).length;
    },

    // The multi-host form, for a slot rendered once per card: `entries` is
    // `[{host, session}]` for EVERY host the slot should occupy after this
    // render, so a card that has gone (or whose session vanished from the graph)
    // has its element torn down by omission. Each element is updated with its
    // own entry's session — the one thing `update` below cannot do, since it
    // knows only one. Returns the number of mounted elements across all hosts.
    // `onBadge` is optional and view-only in practice: see reportBadges. It is
    // handed the same `graph` every row carries, since a badge counts what the
    // BOARD says and not what one host's session does.
    syncHosts(slotName, entries, baseApi = {}, graph = null, onBadge = null) {
      // `hidden` (a Set) overrides the chip-veto union for that entry, and
      // `sample` marks a preview host whose failures never drop — see sync().
      const rows = (entries || []).filter((e) => e && e.host).map((e) => ({
        host: e.host, session: e.session ?? null, only: e.only ?? null, at: e.at ?? null, graph,
        hidden: e.hidden instanceof Set ? e.hidden : null, sample: Boolean(e.sample),
      }));
      sync(slotName, rows, baseApi, true);
      if (onBadge) reportBadges(slotName, graph, onBadge);
      return slotList(slotName).reduce((n, c) => n + c.mounts.size, 0);
    },

    // Every graph tick and every selection change / pill toggle (app.js calls it
    // from renderPanel) for the single-host panel slots: one session, applied to
    // every element the slot has. A contribution with no element yet — its
    // extension loaded but its host not rendered — is skipped, not an error.
    update(slotName, session, graph) {
      for (const c of [...slotList(slotName)]) {
        for (const host of [...c.mounts.keys()]) if (!updateAt(slotName, c, host, session, graph)) break;
      }
    },

    // The core dispatch-modal fields the live `dispatch.field` contributions
    // want hidden, deduped. TWO keys, and the asymmetry is the point:
    //
    //   - fails CLOSED on authority. A name is honoured only if the
    //     extension's MANIFEST declared it (`hideDispatchField`, carried to the
    //     board on the `extensions` announcement and graph.extensions and read
    //     back through hideDispatchFieldsFor). An undeclared name is dropped
    //     and reported — the browser half may never widen what the server half
    //     disclosed, the same rule as `send`.
    //   - fails OPEN on health. Only a contribution with a live element counts,
    //     so the existing "a throwing contribution is REMOVED" rule takes the
    //     veto with it and the core row comes back on the next sync.
    //
    // Reporting is deduped per `extId:name`: app.js recomputes this on modal
    // open, on every model change and on every syncWorkflow, so a misconfigured
    // extension would otherwise print a line per interaction.
    //
    // A function `hides` is called with `ctx.draft` (the core read app.js's
    // dispatchFieldCtx builds) and its return goes through the same manifest
    // filter as a static list — computing the names never widens what may be
    // hidden. A throw, or anything but an array back, REMOVES the contribution,
    // the same rule and the same reason as a throwing fields(): a veto that
    // cannot be computed must fail open, not freeze on its last answer.
    hiddenDispatchFields(ctx) {
      const out = new Set();
      for (const c of [...slotList('dispatch.field')]) {
        if (c.mounts.size === 0 || c.hides == null) continue;
        let names = c.hides;
        if (typeof c.hides === 'function') {
          try {
            names = c.hides(ctx?.draft);
            if (!Array.isArray(names)) throw new Error(`returned ${names === null ? 'null' : typeof names}, not an array`);
          } catch (err) {
            onError(`[ext:${c.extId}] ${c.id} hides failed — contribution removed`, err);
            drop('dispatch.field', c);
            continue;
          }
        }
        const declared = hideDispatchFieldsFor(c.extId) || [];
        for (const name of names) {
          if (declared.includes(name)) { out.add(name); continue; }
          const key = `${c.extId}:${name}`;
          if (hideReported.has(key)) continue;
          hideReported.add(key);
          onError(`[ext:${c.extId}] ${c.id} cannot hide "${name}": not in this extension's manifest hideDispatchField (${declared.join(', ') || 'none'})`);
        }
      }
      return [...out];
    },

    // The per-open half (1.20.0): app.js openModal calls this ONCE per open,
    // after core has reset its own fields and the anchors are synced, and
    // before the modal is shown. It exists because nothing else can tell an
    // open apart: the anchor hosts are static markup, so mount is once per page
    // (bar a subagent teardown) and keeps whatever was typed last time, while
    // `update` fires on every sync — twice per open and again on every model,
    // runtime or mode change. A separate call rather than a flag on update's
    // ctx, because a flag would have to be true on exactly one of open's two
    // syncs, and that is the ordering this is here to stop extensions relying
    // on.
    //
    // Each contribution is handed `open(el, { ...ctx, saved })`, where `saved`
    // is ITS OWN extension's slice of the saved dispatch's `ext` bag (a fresh
    // copy; null when there is none) — narrowed here for the same reason
    // `ext(el)` is forced to `ext.<extId>` on the way out: one extension never
    // reads another's. `ctx.editing` (app.js) says whether a saved schedule is
    // being restored, which is what lets a null `saved` mean "this schedule
    // sent nothing" rather than "apply your default". A throwing `open` REMOVES
    // the contribution, the mount/update rule; the caller re-runs the veto.
    openDispatchFields(ctx, savedExt = null) {
      for (const c of [...slotList('dispatch.field')]) {
        const el = [...c.mounts.values()][0];
        if (!el || typeof c.open !== 'function') continue;
        const slice = isPlainObject(savedExt) ? savedExt[c.extId] : undefined;
        try {
          c.open(el, { ...ctx, saved: slice === undefined ? null : structuredClone(slice) });
        } catch (err) {
          onError(`[ext:${c.extId}] ${c.id} open failed — contribution removed`, err);
          drop('dispatch.field', c);
        }
      }
    },

    // The payload half: every live contribution's `fields(el, ctx)` return, merged
    // over each other in REGISTRATION order and spread over core's own read by
    // the caller (app.js readDispatchFields).
    //
    // A dispatch.field contribution has at most ONE element — its `at` matches
    // exactly one anchor host — so the single entry of `c.mounts` is taken
    // rather than looped over silently.
    //
    // `undefined` VALUES are dropped: a contribution saying "no opinion" must
    // not blank a core field. `null` is a real value and is kept — `|| undefined`
    // is core's own idiom in readCoreDispatchFields, not this slot's to impose.
    // A key a previous contribution already wrote is a COLLISION: reported, last
    // write wins, because two extensions fighting over one payload key is a
    // config problem a human has to see. A throwing `fields()` REMOVES the
    // contribution, unlike a throwing onMessage listener: report-and-keep would
    // leave a broken extension still holding its `hides` veto while contributing
    // nothing to the payload, and removing it is what makes that veto fail open.
    //
    // `ctx` (app.js dispatchFieldCtx: mode, the core draft, agents) is handed
    // on as the second argument to both `fields(el, ctx)` and `ext(el, ctx)`,
    // so a contribution can shape its payload by what core is about to send —
    // the runtime choice, say — without reading core's DOM.
    //
    // `ext(el, ctx)` is the other half of the payload: data for the contribution's
    // OWN server half, not a core field. It lands at `ext.<extId>` — the key is
    // FORCED from the contribution's id, like `send`'s types, so one extension
    // can never write into another's — and the server hands each extension only
    // its own slice (onBeforeDispatch's `ext`). Plain objects from several
    // contributions of one extension merge shallowly; `undefined` is dropped.
    dispatchFields(ctx) {
      const out = {};
      const writer = new Map();
      for (const c of [...slotList('dispatch.field')]) {
        const el = [...c.mounts.values()][0];
        if (!el) continue;
        if (typeof c.ext === 'function') {
          let data;
          try {
            data = c.ext(el, ctx);
          } catch (err) {
            onError(`[ext:${c.extId}] ${c.id} ext failed — contribution removed`, err);
            drop('dispatch.field', c);
            continue;
          }
          if (data !== undefined) {
            out.ext ||= {};
            const prev = out.ext[c.extId];
            out.ext[c.extId] = isPlainObject(prev) && isPlainObject(data) ? { ...prev, ...data } : data;
          }
        }
        if (typeof c.fields !== 'function') continue;
        let got;
        try {
          got = c.fields(el, ctx);
        } catch (err) {
          onError(`[ext:${c.extId}] ${c.id} fields failed — contribution removed`, err);
          drop('dispatch.field', c);
          continue;
        }
        if (!got || typeof got !== 'object') continue;
        for (const [key, value] of Object.entries(got)) {
          if (value === undefined) continue;
          // `ext` is the namespaced bag above, never a field a contribution
          // may write whole — that would let it overwrite a sibling's slice.
          if (key === 'ext') { onError(`[ext:${c.extId}] ${c.id} cannot write dispatch field "ext"; return extension data from ext(el, ctx)`); continue; }
          const prev = writer.get(key);
          if (prev) onError(`[ext:${c.extId}] ${c.id} overwrites dispatch field "${key}", already written by ${prev}`);
          writer.set(key, `[ext:${c.extId}] ${c.id}`);
          out[key] = value;
        }
      }
      return out;
    },

    // `label`/`icon` are what the board needs to DRAW a chrome affordance for a
    // contribution before it has a host at all — the view slot's rail button.
    // Both are undefined for the slots that need neither.
    // Total px of tile height the live `task.body` contributions want for one
    // tile (`weight(taskId, graph)`, summed). Synchronous and cheap by contract —
    // it runs per tile per layout pass. A throwing weight counts as 0 and is
    // reported once per contribution, NOT removed: it runs in a measurement pass,
    // and a bad number must not cost the extension its UI. Anything that is not a
    // finite positive number counts as 0.
    taskBodyWeight(taskId, graph = null) {
      let total = 0;
      for (const c of slotList('task.body')) {
        if (typeof c.weight !== 'function') continue;
        let w;
        try {
          w = c.weight(taskId, graph);
        } catch (err) {
          const key = `${c.extId}:${c.id}`;
          if (!weightReported.has(key)) { weightReported.add(key); onError(`[ext:${c.extId}] ${c.id} weight failed — counted as 0`, err); }
          continue;
        }
        if (Number.isFinite(w) && w > 0) total += w;
      }
      return total;
    },

    // The `card.action` items for one card, in registration order, for the
    // board to append to its right-click and Actions menus. Each is
    // `{ label, run, hint?, icon?, danger? }`: `label` and `hint` are TEXT
    // (the menu escapes them, `hint` is drawn in the trailing slot), `icon` is
    // markup exactly as a `view`'s is. `run` is wrapped so a throw is reported
    // rather than escaping into the menu's click handler. A throwing `items()`
    // removes the contribution; a malformed item is skipped and reported.
    // `items(session, graph, api)` gets the same per-extension api a mounted
    // contribution does, since a value slot has no mount to receive it in.
    menuItems(session, graph, baseApi) {
      return valueMenuItems('card.action', session, graph, baseApi);
    },

    // The `task.action` items for one task tile's right-click menu — the same
    // item shape and the same guards as menuItems(), with the TILE as subject:
    // `items(task, graph, api)` where `task` is `{ id, name, adhoc }`.
    taskMenuItems(task, graph, baseApi) {
      return valueMenuItems('task.action', task, graph, baseApi);
    },

    // The spend ceiling for one card's cost tag: `{ usd, reached }` from the
    // first `card.cost` contribution that answers, or null. NUMBERS only — core
    // draws the ` / $50.00` and the reached tone itself, so no extension string
    // reaches that markup. A second answering contribution is a collision,
    // reported once per pair for the life of the page (this runs per card per
    // render). A throwing `cost()` removes the contribution.
    costCeiling(session, graph) {
      let found = null;
      for (const c of [...slotList('card.cost')]) {
        let got;
        try {
          got = c.cost(session, graph);
        } catch (err) {
          onError(`[ext:${c.extId}] ${c.id} cost failed — contribution removed`, err);
          drop('card.cost', c);
          continue;
        }
        if (got == null) continue;
        const usd = Number(got.usd);
        if (!Number.isFinite(usd) || usd <= 0) continue;
        if (found) {
          const key = `${found.by}|${c.extId}:${c.id}`;
          if (!costReported.has(key)) { costReported.add(key); onError(`[ext:${c.extId}] ${c.id} also set a cost ceiling; ${found.by}'s is shown`); }
          continue;
        }
        found = { usd, reached: Boolean(got.reached), by: `${c.extId}:${c.id}` };
      }
      return found && { usd: found.usd, reached: found.reached };
    },

    // The chip for one link: `{ key, label, href, icon }` from the first
    // `link.chip` contribution that answers for it, or null. `key` is the chip
    // veto key (`<extId>:<id>`). A throwing `chip()` removes the contribution.
    linkChip(link, graph, baseApi) {
      for (const c of [...slotList('link.chip')]) {
        let got;
        try {
          got = c.chip(link, graph, apiFor(c.extId, baseApi));
        } catch (err) {
          onError(`[ext:${c.extId}] ${c.id} chip failed — contribution removed`, err);
          drop('link.chip', c);
          continue;
        }
        if (got == null) continue;
        if (typeof got.label !== 'string' || !got.label) {
          onError(`[ext:${c.extId}] ${c.id} returned a link chip without a label`);
          continue;
        }
        return {
          key: `${c.extId}:${c.id}`,
          label: got.label,
          href: typeof got.href === 'string' ? got.href : '',
          icon: safeChipIcon(got.icon),
        };
      }
      return null;
    },

    contributions(slotName) {
      return slotList(slotName).map((c) => ({
        extId: c.extId, id: c.id, mounted: c.mounts.size > 0,
        ...(c.label ? { label: c.label } : {}),
        ...(c.icon ? { icon: c.icon } : {}),
      }));
    },
  };
}

// localStorage behind a key prefix, every access under try/catch: storage can be
// absent (a test), full, or blocked (private mode), and an extension's remembered
// preference is never worth a thrown error in a render. `raw(key)` deliberately
// escapes the prefix for a key that predates the extensions API (e.g. the builtin
// checklist's `wrangler.checklistOpen`) — so a migrated feature keeps its users' stored state;
// a NEW key has no reason to use it.
export function namespacedStorage(prefix, storage = globalThis.localStorage) {
  const wrap = (key) => ({
    get() { try { return storage?.getItem(key) ?? null; } catch { return null; } },
    set(value) { try { storage?.setItem(key, value); } catch {} },
    remove() { try { storage?.removeItem(key); } catch {} },
  });
  return {
    get: (key) => wrap(prefix + key).get(),
    set: (key, value) => wrap(prefix + key).set(value),
    remove: (key) => wrap(prefix + key).remove(),
    raw: (key) => wrap(key),
  };
}
