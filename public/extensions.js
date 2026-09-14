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
//
// `styles` is the manifest's stylesheet (server/extensions/<id>/public/*.css,
// served from the same /ext/<id>/ route as the module) and is loaded as a plain
// <link>, not injected text: the browser dedupes, caches and — the point here —
// lets the rules be removed again by dropping one node when the extension is
// toggled off, with no bookkeeping of which selectors belonged to whom. It is
// attached and detached with the module, so an extension whose UI has gone
// leaves no rules behind styling elements the core still draws. `client` may be
// null for a styles-only extension; `styles` may be null for the common case of
// a module with no CSS of its own.
export function createClientExtensionLoader(slots, {
  importer = (url) => import(url),
  onError = (...a) => console.error(...a),
  document: doc = globalThis.document,
} = {}) {
  const loaded = new Set();
  const sheets = new Map(); // id -> the <link> element, so unload can remove it

  function addStyles(id, href) {
    if (!href || sheets.has(id) || !doc) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.ext = id;
    doc.head.appendChild(link);
    sheets.set(id, link);
  }

  function removeStyles(id) {
    const link = sheets.get(id);
    sheets.delete(id);
    if (link?.parentNode) link.parentNode.removeChild(link);
  }

  async function load(list) {
    let changed = false;
    for (const entry of Array.isArray(list) ? list : []) {
      const { id, client, styles } = entry || {};
      const mod = typeof client === 'string' && client ? client : null;
      const css = typeof styles === 'string' && styles ? styles : null;
      // An announcement carrying neither asset is malformed — the server only
      // ever lists an extension that has one — and is skipped rather than
      // marked loaded, which would swallow the real entry on a later connect.
      if (typeof id !== 'string' || !id || (!mod && !css) || loaded.has(id)) continue;
      loaded.add(id);
      // Before the import, so a module's first render already has its rules —
      // a stylesheet that lands after mount is a visible flash of unstyled UI.
      addStyles(id, css);
      try {
        if (mod) {
          const loadedMod = await importer(mod);
          if (typeof loadedMod?.default?.register !== 'function') throw new Error(`${mod} has no default export with a register(slots) function`);
          loadedMod.default.register(slots.forExtension(id));
        }
        changed = true;
      } catch (err) {
        onError(`[ext:${id}] failed to load`, err);
        slots.removeExtension(id);
        removeStyles(id);
        loaded.delete(id);
      }
    }
    return changed;
  }

  function unload(id) {
    if (!loaded.has(id)) return false;
    loaded.delete(id);
    slots.removeExtension(id);
    removeStyles(id);
    return true;
  }

  return { load, unload, isLoaded: (id) => loaded.has(id) };
}
