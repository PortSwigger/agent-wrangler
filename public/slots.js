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
// an optional `hides` veto over named core rows. Its entries carry `at`
// alongside `only` — see sync(). A contribution may also return `ext(el)`,
// data for its OWN server half, which rides the dispatch frame as
// `ext.<extId>` — see dispatchFields().
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
export const SLOT_NAMES = ['panel.section', 'panel.metaChip', 'card.pill', 'view', 'dispatch.field', 'card.action', 'card.cost', 'task.action'];

// The value slots and the one function each contribution must carry in place
// of mount().
const VALUE_SLOTS = { 'card.action': 'items', 'card.cost': 'cost', 'task.action': 'items' };

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

export function createSlots({ document, storage, onError = (...a) => console.error(...a), handlerTypesFor = () => [], hideDispatchFieldsFor = () => [], version = null }) {
  const bySlot = new Map(SLOT_NAMES.map((n) => [n, []]));
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
      });
    }
    return apis.get(extId);
  }

  // Give `c` an element inside `host`, mounting only if it has none there yet.
  // Returns false when the contribution was dropped (its mount threw), which is
  // the caller's signal to stop feeding it hosts.
  function ensure(slotName, c, host, baseApi) {
    const existing = c.mounts.get(host);
    if (existing && existing.parentNode === host) return true;
    if (existing) teardownAt(c, host);
    const el = document.createElement('div');
    el.className = 'ext-slot';
    el.dataset.ext = c.extId;
    el.dataset.contrib = c.id;
    host.appendChild(el);
    c.mounts.set(host, el);
    try {
      c.mount(el, apiFor(c.extId, baseApi));
    } catch (err) {
      onError(`[ext:${c.extId}] ${c.id} mount failed — contribution removed`, err);
      drop(slotName, c);
      return false;
    }
    return true;
  }

  function updateAt(slotName, c, host, session, graph) {
    const el = c.mounts.get(host);
    if (!el || typeof c.update !== 'function') return true;
    try {
      c.update(el, session, graph);
    } catch (err) {
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
  function sync(slotName, entries, baseApi, withUpdate) {
    for (const c of [...slotList(slotName)]) {
      const mine = entries.filter((e) =>
        (!e.only || (e.only.extId === c.extId && e.only.id === c.id))
        && (!e.at || e.at === c.at));
      const keep = new Set(mine.map((e) => e.host));
      for (const host of [...c.mounts.keys()]) if (!keep.has(host)) teardownAt(c, host);
      for (const { host, session, graph } of mine) {
        if (!ensure(slotName, c, host, baseApi)) break;
        if (withUpdate && !updateAt(slotName, c, host, session, graph)) break;
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
      if (contribution.ext != null && typeof contribution.ext !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} ext must be a function`);
      // Dispatch-modal specifics. Both THROW for the same reason: a typo must
      // fail at load, not render nowhere.
      if (slotName === 'dispatch.field') {
        if (!DISPATCH_ANCHORS.includes(contribution.at)) throw new Error(`[ext:${extId}] ${contribution.id} has an unknown dispatch anchor "${contribution.at}" (known: ${DISPATCH_ANCHORS.join(', ')})`);
        if (contribution.hides != null && (!Array.isArray(contribution.hides) || contribution.hides.some((f) => typeof f !== 'string' || !f))) {
          throw new Error(`[ext:${extId}] ${contribution.id} hides must be an array of dispatch field names`);
        }
      }
      if (list.some((c) => c.extId === extId && c.id === contribution.id)) throw new Error(`[ext:${extId}] ${contribution.id} is already registered in ${slotName}`);
      list.push({ ...contribution, extId, slotName, mounts: new Map() });
    },

    // A registrar bound to one extension id, which is what an extension module's
    // register() receives — so a module can only ever register under its own id.
    // `onMessage` is here as well as on the api because a subscription needs no
    // host: a module with no contribution at all (or one whose frames are not
    // any single contribution's business) has nowhere else to ask for one, and a
    // subscription taken here is taken exactly once per module load.
    forExtension(extId) {
      return {
        register: (slotName, contribution) => this.register(slotName, extId, contribution),
        onMessage: (fn) => subscribe(extId, fn),
      };
    },

    removeExtension(extId) {
      for (const [, list] of bySlot) {
        for (const c of [...list]) if (c.extId === extId) { list.splice(list.indexOf(c), 1); teardown(c); }
      }
      apis.delete(extId);
      // A disabled, uninstalled or failed-to-load extension must stop HEARING
      // too, not just stop drawing: extensions.js calls this on unload, so the
      // subscription dies with the module that took it and a later re-enable
      // re-imports and re-subscribes.
      listeners.delete(extId);
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
    mountInto(slotName, hostEl, baseApi = {}) {
      if (!hostEl) return 0;
      sync(slotName, [{ host: hostEl }], baseApi, false);
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
      const rows = (entries || []).filter((e) => e && e.host).map((e) => ({ host: e.host, session: e.session ?? null, only: e.only ?? null, at: e.at ?? null, graph }));
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
    hiddenDispatchFields() {
      const out = new Set();
      for (const c of slotList('dispatch.field')) {
        if (c.mounts.size === 0 || !Array.isArray(c.hides)) continue;
        const declared = hideDispatchFieldsFor(c.extId) || [];
        for (const name of c.hides) {
          if (declared.includes(name)) { out.add(name); continue; }
          const key = `${c.extId}:${name}`;
          if (hideReported.has(key)) continue;
          hideReported.add(key);
          onError(`[ext:${c.extId}] ${c.id} cannot hide "${name}": not in this extension's manifest hideDispatchField (${declared.join(', ') || 'none'})`);
        }
      }
      return [...out];
    },

    // The payload half: every live contribution's `fields(el)` return, merged
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
    // `ctx` is accepted but not passed on — the contribution signature is
    // `fields(el)` — so the merge site has one call shape and a later minor can
    // widen to `fields(el, ctx)` without touching the caller.
    //
    // `ext(el)` is the other half of the payload: data for the contribution's
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
            data = c.ext(el);
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
          got = c.fields(el);
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
          if (key === 'ext') { onError(`[ext:${c.extId}] ${c.id} cannot write dispatch field "ext"; return extension data from ext(el)`); continue; }
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
// escapes the prefix for a key that predates the extensions API — the checklist's
// `wrangler.checklistOpen` — so a migrated feature keeps its users' stored state;
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
