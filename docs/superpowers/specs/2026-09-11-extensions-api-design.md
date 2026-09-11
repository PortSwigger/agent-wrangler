# Extensions API (checklist proof of concept)

**Status:** implemented
**Date:** 2026-09-11
**Scope:** an in-repo extensions API that replaces per-feature on/off flags with one
manifest per optional feature, gated as a unit. The per-session checklist is the
only feature migrated so far; it is the proof of concept and the template for the
next one. No external loader, no third-party extensions: every manifest is a
static import in `server/extensions/index.js`.

This records the design as implemented (PRs `extensions-api-client` and
`extensions-api-docs`). Where the original plan and the code differ, the code is
described here.

## Problem

Each optional feature (checklist, task-memory, archive-review, ...) grew its own
flag, and the checklist alone had to be gated in four places that had to stay in
step by hand: tool registration (`activeTools`), the launch grant
(`allowedToolsArg` plus a hand-copied `CHECKLIST_TOOLS` list), the skill nudge and
Codex catalog (`agent-skills.js`'s `DISABLEABLE` map) and the client panel
(`graph.checklistEnabled`). Each new feature would repeat that fan-out, plus a
`set-<feature>-enabled` control handler, a settings def and a fresh rung in
`app.js`'s `if (id === ...)` settings ladder.

## Manifest

One directory per extension, `server/extensions/<id>/`, whose `index.js` exports
`dir` (from `import.meta.url`) and a default manifest:

```js
export const dir = fileURLToPath(new URL('.', import.meta.url));
export default {
  id: 'checklist',                 // /^[a-z][a-z0-9-]*$/, unique
  label: 'Per-session checklist',  // settings toggle label
  help: '... Turning it off hides the panel straight away; the MCP tools follow at a session\'s next resume.',
  defaultEnabled: true,
  dir,
  stores:   { checklist: () => new ChecklistStore() },   // factories, instantiated once by index.js
  handlers: [ /* control-WS handlers {type, handler} */ ],
  tools:    [ /* MCP tools {name, description, inputSchema, handler} */ ],
  skills:   ['checklist'],          // agent-skills/skills/<name>
  graph:    ({ stores }) => ({ checklists: stores.checklist.snapshot() }),
  session:  { onPurge: ({ sessionId, stores }) => stores.checklist.forget(sessionId) },
  sweeps:   [ /* {id, everyMs, run({stores, rebuild, broadcast})} */ ],
  client:   'public/index.js',      // must resolve inside <dir>/public/
};
```

`validateManifest` runs at boot and throws with the extension id in the message
for: a bad or duplicate id, a tool without `name`/`handler`, a handler without
`type`/`handler`, a store that is not a factory, an unknown `session` hook name
(the known set is `SESSION_HOOKS`: `onArchive`, `onFork`, `onPurge`,
`onDispatch`, `onResume`), a sweep without a positive finite `everyMs`, and a
`client` path that does not resolve inside the manifest's own `public/`.
`server/index.js` catches any loader error, logs it and exits 1, the same posture
as the instance lock.

## Loader outputs

`loadExtensions({ cfg, builtin, coreToolNames, coreHandlerTypes })` walks
`BUILTIN` once and returns:

| key | contents | enabled only? |
|---|---|---|
| `list` | `[{id, label, help, defaultEnabled, enabled}]` for every builtin | no |
| `stores` | `{name: factory}` | yes |
| `handlers` | control-WS handlers | yes |
| `tools` | MCP tools | yes |
| `allowedToolNames` | `tools.map(t => t.name)` | yes |
| `skillIds` / `disabledSkillIds` | skill names of enabled / disabled manifests | split |
| `graphContributors` | `[{id, contribute}]` | yes |
| `sessionHooks` | `{onArchive: [], onFork: [], ...}` | yes |
| `sweeps` | `[{extId, id, everyMs, run}]` | yes |
| `clientManifest` | `[{id, client: '/ext/<id>/index.js'}]` | yes, and only with a `client` |
| `dirs` | `{id: dir}` | yes |

Tool names and handler types are checked for uniqueness against each other and
against `coreToolNames`/`coreHandlerTypes`. Those are passed in by `index.js`
rather than imported, because the loader is a leaf (below) and the core
registries pull in `session-manager`.

`getExtensions()` memoises one `loadExtensions()` result. `server/index.js` calls
it first at boot with the core names; every other consumer (`client-config.js`,
`agent-skills.js`, `mcp/tools/index.js`, `control/router.js`) defaults to the
same memo but takes an injectable `{ ext }` so tests never touch it or
`config.json`. `router.js` builds its type-to-handler map lazily on the first
frame so the loader is never run at import time, before `index.js` has passed
the core names in.

## Leaf constraint

`server/mcp/client-config.js` and `server/agent-skills.js` are imported by the
agent adapters (`server/agents/*`), and both now import the loader. So
`server/extensions/index.js`, every manifest and everything a manifest imports
must stay leaf-compatible: no import of `session-manager`, `state-reader`,
`tmux-scraper` or `index.js`. `server/extensions/index.test.js` asserts this
over the real `BUILTIN` with a static regex over import lines. A manifest's
tools and handlers reach server state only through the bag they are handed
(`deps.ext.stores` for MCP tools, `ctx.ext.stores` for control handlers). Both
bags are the same `extBag = { stores, list }` object in `index.js`.

## Gating model

Enabled state is `extensions.<id>` in `config.json`, read by
`extensionEnabled(id, defaultEnabled, cfg)` in `config-store.js`. It is a
**load-time** gate: a disabled extension contributes nothing to any loader
output except `list` and `disabledSkillIds`, so its tools are genuinely
unregistered (not merely ungranted), its handlers unknown to the router, its
skill dropped from the nudge and the Codex catalog, its graph keys absent and its
client not served.

The generic `extension-enabled` control handler (replacing every
`set-<feature>-enabled`) writes the flag and rebuilds. The UI flips live and
nothing else does. `graph.extensions[].enabled` is re-read from config on every
rebuild (`extensionsForGraph`) rather than taken from `ext.list`'s boot
snapshot, and the client mounts or unmounts that extension's slot contributions
off it (`syncClientExtensions`, the loader's `unload`) — so turning an extension
off takes its panel off the board on the next tick, which is what the
per-feature flag it replaced already did. Tools, handlers, stores, graph
contributors and client assets stay as loaded, so a running session's MCP tools
follow at its next resume, and an extension that was OFF at boot has none of
those loaded at all and cannot be turned on without a restart. The manifest's
`help` must say which half moves when; `public/settings.js`'s `setExtensionDefs`
appends a restart note if it does not.

Retired flags map onto the new key through `LEGACY_FLAGS` in `config-store.js`
(`{ checklistEnabled: ['extensions', 'checklist'] }`). `readConfig()` runs
`migrateLegacyFlags` and writes the file back once if anything changed; an
explicit new-style boolean wins over the legacy key, and the legacy key is
deleted either way. A missing or unparseable file is never written.

## Derived registries

- `mcp/tools/index.js`: `TOOLS` is core-only; `activeTools({ ext })` is
  `[...TOOLS, ...ext.tools]`.
- `mcp/client-config.js`: `ALLOWED_TOOLS` is core-only; `allowedToolsArg({ ext })`
  appends `ext.allowedToolNames`. The two-place rule (register AND allow-list)
  is therefore derived for extension tools and still manual for core ones.
- `control/handlers/index.js`: `CONTROL_HANDLERS` is core-only;
  `activeHandlers({ ext })` appends `ext.handlers`.
- `agent-skills.js`: `activeSkillEntries` drops `task-memory` when its own flag is
  off (it is not an extension yet) and any name in `ext.disabledSkillIds`.

## Composition in `server/index.js`

1. `getExtensions({ coreToolNames, coreHandlerTypes })`, then instantiate every
   store factory once into `extStores`.
2. `assertGraphKeys` on each contributor's output against `RESERVED_GRAPH_KEYS`
   (every key `rebuildOnce` sets itself). Checked once at boot because the
   rebuild is a ~4 s tick where nothing may log or throw.
3. Bind `ext.sessionHooks` onto `sessionManager._extHooks`, closing over
   `extStores`.
4. MCP deps and WS ctx both carry `ext: extBag`.
5. `rebuildOnce` sets `graph.extensions` from `ext.list` and then
   `Object.assign`s each contributor's output onto the graph.
6. The connect path sends `{ type: 'extensions', list: ext.clientManifest }`
   right after `config`, before the first graph.
7. `main()` starts one unref'd interval per sweep, errors logged with
   `[ext:<extId>:<sweepId>]`.

## Session lifecycle hooks

`SessionManager._extHooks` holds an array per hook name; `_fireExtHooks` runs
them sequentially, catches and logs each throw, and never aborts the core
operation. Fire sites: `onArchive` in `archive()` (unawaited, with
`wasArchived`), `onFork` after the fork entry is saved, `onPurge` from
`forget()` (fire-and-forget; `forget` stays synchronous), `onDispatch` after the
new entry is saved, `onResume` at the end of `_doResume` (not `resume()`, whose
coalescing would fire it twice for one relaunch). Hooks default to empty so every
pre-existing SessionManager test stays inert.

The checklist declares only `onPurge`. Its lifecycle is by construction: resume
keeps the list, a fork starts empty, archive keeps it, only a purge forgets.
`server/extensions/checklist/lifecycle.test.js` asserts the manifest has no
`onFork`/`onArchive`.

## `/ext/<id>/*` route

`http-handler.js` takes `extensionAssets(id) => dir | null`, which `index.js`
implements as a lookup in `ext.dirs` (enabled extensions only). An unknown or
disabled id is a 404; the rest of the path is resolved with `path.resolve`
against `<dir>/public` and refused with 403 if it does not stay under that
prefix (`join(normalize())` would fold a climbing `..` back inside). Served with
`Cache-Control: no-store`, GET only, same posture as `public/`.

## Client slots

`public/slots.js` declares `SLOT_NAMES = ['panel.section', 'panel.metaChip',
'card.pill']` and `createSlots({ document, storage })` with `register`,
`forExtension(id)` (a registrar bound to one id), `mountInto(slot, hostEl, api)`,
`update(slot, session, graph)`, `removeExtension(id)` and `contributions(slot)`.
A new slot needs an entry in `SLOT_NAMES` and a host in `app.js`.

- Every contribution owns one element per host element; mount-once is per host
  element identity. `#panel-sections` is stable and mounts once;
  `renderPanel`'s chips row is rebuilt via innerHTML each render, so its
  `.sess-meta-ext` host is re-mounted each time.
- Hosts (`#panel-sections`, `.sess-meta-ext`) and the per-contribution wrapper
  (`.ext-slot`) are `display: contents`, so an extension's element lays out as
  if it were the host's own child.
- `mount`/`update`/`unmount` each run under try/catch; a throwing contribution is
  removed and reported, and the rest of the board carries on.
- Each extension's `api` is app.js's base (`send`, `selectedSessionId`,
  `requestPanelRender`) plus a `namespacedStorage('ext.<id>.')` wrapper.
  `storage.raw(key)` escapes the prefix for a key that predates the API (the
  checklist's `wrangler.checklistOpen`); a new key has no reason to use it.

`public/extensions.js`'s `createClientExtensionLoader(slots)` imports each
`client` URL as an ES module, requires `default.register(slots)`, and is
idempotent per id across reconnects. A failed load is reported, its
registrations removed and the id released so the next connect retries.

The checklist client lives in `server/extensions/checklist/public/index.js`
(with `checklist-dom.js` beside it) and contributes the panel to
`panel.section` and its collapsed disclosure chip to `panel.metaChip`. It
imports the board's icons by absolute URL (`/icons.js`), because a relative
import from `/ext/checklist/` would 404.

## Settings

`public/settings.js` has an Extensions tab whose rows are built by
`setExtensionDefs(graph.extensions)` on every graph push: one `ext:<id>` toggle
per extension, `scope: 'server'`. `app.js`'s server get/set bridge handles the
`ext:` prefix generically (read back from `graph.extensions`, write via
`extension-enabled`), so a new extension needs no settings edit and no new rung.

## Adding the next extension

1. Create `server/extensions/<id>/index.js` exporting `dir` and the manifest;
   move the feature's store, handlers, tools and (if any) client module under it.
2. Add the manifest to `BUILTIN`.
3. Add a `LEGACY_FLAGS` row for the retired flag; delete the flag's accessor in
   `config-store.js`, its `set-<x>-enabled` handler, its settings def and its
   `app.js` rung.
4. Nothing else: registration, launch grant, skill gating, graph, client and the
   settings toggle are derived.

## Deferred

- `card.pill` slot host: declared in `SLOT_NAMES` for shape only. `cards.js`
  builds cards as innerHTML strings and has no element to mount into yet.
- CSS slot: an extension's rules still live in `public/styles.css`
  (`#checklist...`, `.checklist-pill`).
- Migrating task-memory and archive-review onto manifests. task-memory keeps its
  own `taskMemoryEnabled` flag and its special case in `activeSkillEntries`
  until then.
- Turning an extension ON live when it was OFF at boot. Its store, handlers,
  graph contribution and client asset are all decided by `loadExtensions`, so
  the panel would mount backed by nothing. Making that work means loading every
  extension unconditionally and checking `enabled` at each call site instead —
  a change to the loader's contract, not a patch. (Turning one OFF live, and
  back on within the same boot, both work today.) `--allowedTools` is baked into
  a session's launch argv regardless, so a running session can never gain or
  lose tools without a relaunch.
