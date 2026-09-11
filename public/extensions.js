// Loads the client half of every enabled extension the server announced
// (`{type:'extensions', list:[{id, client}]}` on connect, before the first
// graph) as an ES module from its /ext/<id>/ URL, and hands it a registrar bound
// to its own id (slots.forExtension) so it can only contribute under that id.
//
// Idempotent per id — the server re-sends the list on EVERY connect, so a
// reconnect must register nothing twice. A failed load is reported, whatever it
// registered before failing is removed, and the id is released so the next
// connect retries it (a server restart may have shipped the fix). One broken
// extension never stops the others loading, and never blanks the board: the
// core does not `await` this at all.
export function createClientExtensionLoader(slots, { importer = (url) => import(url), onError = (...a) => console.error(...a) } = {}) {
  const loaded = new Set();
  return async function load(list) {
    let changed = false;
    for (const entry of Array.isArray(list) ? list : []) {
      const { id, client } = entry || {};
      if (typeof id !== 'string' || !id || typeof client !== 'string' || loaded.has(id)) continue;
      loaded.add(id);
      try {
        const mod = await importer(client);
        if (typeof mod?.default?.register !== 'function') throw new Error(`${client} has no default export with a register(slots) function`);
        mod.default.register(slots.forExtension(id));
        changed = true;
      } catch (err) {
        onError(`[ext:${id}] failed to load`, err);
        slots.removeExtension(id);
        loaded.delete(id);
      }
    }
    return changed;
  };
}
