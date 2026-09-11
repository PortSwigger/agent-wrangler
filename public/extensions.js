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
//
// `unload` is the settings toggle's half: graph.extensions[].enabled is read
// live by the server, so a flip has to take the extension's DOM off the board
// without a reload. It drops the id from `loaded` as well as tearing the
// contributions down, so turning the toggle back on re-imports and re-registers
// (the browser's module cache makes the second import free). The server only
// ever announces extensions that were ON at boot, so an extension that booted
// OFF has nothing to re-import here and still needs a restart — which is what
// the manifest's help text says.
export function createClientExtensionLoader(slots, { importer = (url) => import(url), onError = (...a) => console.error(...a) } = {}) {
  const loaded = new Set();

  async function load(list) {
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
  }

  function unload(id) {
    if (!loaded.has(id)) return false;
    loaded.delete(id);
    slots.removeExtension(id);
    return true;
  }

  return { load, unload, isLoaded: (id) => loaded.has(id) };
}
