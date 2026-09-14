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
export const SLOT_NAMES = ['panel.section', 'panel.metaChip', 'card.pill'];

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
export function createSlots({ document, storage, onError = (...a) => console.error(...a) }) {
  const bySlot = new Map(SLOT_NAMES.map((n) => [n, []]));
  const apis = new Map();

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

  // The per-extension `api` is the base one the caller hands in, plus a storage
  // namespaced to `ext.<id>.` so two extensions cannot collide on a
  // localStorage key. Built once per extension, so a contribution can compare
  // it by identity across renders.
  function apiFor(extId, baseApi) {
    if (!apis.has(extId)) apis.set(extId, { ...baseApi, storage: namespacedStorage(`ext.${extId}.`, storage) });
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

  // Reconcile a slot against the hosts it should be in RIGHT NOW: mount into
  // each, tear down anything left in a host that isn't listed, and (when the
  // caller passed sessions) update each element with its own host's session.
  function sync(slotName, entries, baseApi, withUpdate) {
    const keep = new Set(entries.map((e) => e.host));
    for (const c of [...slotList(slotName)]) {
      for (const host of [...c.mounts.keys()]) if (!keep.has(host)) teardownAt(c, host);
      for (const { host, session, graph } of entries) {
        if (!ensure(slotName, c, host, baseApi)) break;
        if (withUpdate && !updateAt(slotName, c, host, session, graph)) break;
      }
    }
  }

  return {
    register(slotName, extId, contribution) {
      const list = slotList(slotName);
      if (!contribution || typeof contribution.id !== 'string' || !contribution.id) throw new Error(`[ext:${extId}] contribution to ${slotName} has no id`);
      if (typeof contribution.mount !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} has no mount function`);
      if (list.some((c) => c.extId === extId && c.id === contribution.id)) throw new Error(`[ext:${extId}] ${contribution.id} is already registered in ${slotName}`);
      list.push({ ...contribution, extId, slotName, mounts: new Map() });
    },

    // A registrar bound to one extension id, which is what an extension module's
    // register() receives — so a module can only ever register under its own id.
    forExtension(extId) {
      return { register: (slotName, contribution) => this.register(slotName, extId, contribution) };
    },

    removeExtension(extId) {
      for (const [, list] of bySlot) {
        for (const c of [...list]) if (c.extId === extId) { list.splice(list.indexOf(c), 1); teardown(c); }
      }
      apis.delete(extId);
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
    syncHosts(slotName, entries, baseApi = {}, graph = null) {
      const rows = (entries || []).filter((e) => e && e.host).map((e) => ({ host: e.host, session: e.session ?? null, graph }));
      sync(slotName, rows, baseApi, true);
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

    contributions(slotName) {
      return slotList(slotName).map((c) => ({ extId: c.extId, id: c.id, mounted: c.mounts.size > 0 }));
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
