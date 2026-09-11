// The client half of the extensions API: named slots an extension's client
// module (served from /ext/<id>/, see extensions.js) contributes DOM into, and
// the one place the board renders those contributions from. A leaf — no DOM at
// import; `document` is injected so the reconciliation rules are unit-testable
// the way chat-dom.js is.
//
// A new slot needs BOTH an entry here AND a host in app.js that calls mountInto/
// update for it — SLOT_NAMES is the registry, and register() refuses a name
// that isn't in it so a typo in an extension fails at load rather than
// rendering nowhere. `card.pill` is declared for shape only: cards.js builds its
// cards as innerHTML strings and has no host yet.
export const SLOT_NAMES = ['panel.section', 'panel.metaChip', 'card.pill'];

// Every contribution owns exactly ONE element per host element, created here and
// handed to mount(el, api) once. "Mount-once" is per HOST ELEMENT identity, not
// per contribution: renderPanel rebuilds its chips row via innerHTML on every
// render, so a fresh row is a fresh host and the chip is mounted again into it
// (the previous element died with the old row; unmount is told). A host that is
// the same element across renders — #panel-sections — mounts once for the life
// of the page.
//
// An extension must never blank the board: mount/update/unmount are each run
// under try/catch and a throwing contribution is REMOVED (its element dropped,
// the error reported) while every other contribution carries on — the same
// lesson as module-syntax.test.js's blank-dashboard incident, applied at run
// time to code the core does not own.
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

  function teardown(c) {
    if (c.el) {
      try { c.unmount?.(c.el); } catch (err) { onError(`[ext:${c.extId}] ${c.id} unmount failed`, err); }
      if (c.el.parentNode) c.el.parentNode.removeChild(c.el);
    }
    c.el = null;
    c.host = null;
  }

  // The per-extension `api` is the base one app.js hands mountInto, plus a
  // storage namespaced to `ext.<id>.` so two extensions cannot collide on a
  // localStorage key. Built once per extension, so a contribution can compare
  // it by identity across renders.
  function apiFor(extId, baseApi) {
    if (!apis.has(extId)) apis.set(extId, { ...baseApi, storage: namespacedStorage(`ext.${extId}.`, storage) });
    return apis.get(extId);
  }

  return {
    register(slotName, extId, contribution) {
      const list = slotList(slotName);
      if (!contribution || typeof contribution.id !== 'string' || !contribution.id) throw new Error(`[ext:${extId}] contribution to ${slotName} has no id`);
      if (typeof contribution.mount !== 'function') throw new Error(`[ext:${extId}] ${contribution.id} has no mount function`);
      if (list.some((c) => c.extId === extId && c.id === contribution.id)) throw new Error(`[ext:${extId}] ${contribution.id} is already registered in ${slotName}`);
      list.push({ ...contribution, extId, slotName, el: null, host: null });
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

    // Give every contribution to `slotName` its element inside `hostEl`,
    // mounting only those not already mounted into THIS host. Returns the
    // number of contributions now mounted there.
    mountInto(slotName, hostEl, baseApi = {}) {
      if (!hostEl) return 0;
      for (const c of [...slotList(slotName)]) {
        if (c.host === hostEl && c.el && c.el.parentNode === hostEl) continue;
        if (c.el) teardown(c);
        const el = document.createElement('div');
        el.className = 'ext-slot';
        el.dataset.ext = c.extId;
        el.dataset.contrib = c.id;
        hostEl.appendChild(el);
        c.el = el;
        c.host = hostEl;
        try {
          c.mount(el, apiFor(c.extId, baseApi));
        } catch (err) {
          onError(`[ext:${c.extId}] ${c.id} mount failed — contribution removed`, err);
          drop(slotName, c);
        }
      }
      return slotList(slotName).filter((c) => c.host === hostEl).length;
    },

    // Every graph tick and every selection change / pill toggle (app.js calls it
    // from renderPanel). A contribution with no element yet — its extension
    // loaded but its host not rendered — is skipped, not an error.
    update(slotName, session, graph) {
      for (const c of [...slotList(slotName)]) {
        if (!c.el || typeof c.update !== 'function') continue;
        try {
          c.update(c.el, session, graph);
        } catch (err) {
          onError(`[ext:${c.extId}] ${c.id} update failed — contribution removed`, err);
          drop(slotName, c);
        }
      }
    },

    contributions(slotName) {
      return slotList(slotName).map((c) => ({ extId: c.extId, id: c.id, mounted: Boolean(c.el) }));
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
