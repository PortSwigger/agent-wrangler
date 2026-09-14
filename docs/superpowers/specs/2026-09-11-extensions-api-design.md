# Extensions API

**Status:** implemented; `BUILTIN` is empty
**Date:** 2026-09-11
**Scope:** an in-repo extensions API that lets an optional feature be declared as
one manifest and gated as a unit, instead of growing its own flag and fanning it
out by hand. No feature is migrated onto it yet — this lands the API, its seams
and its tests; the first manifest is the proof. No external loader, no
third-party extensions: every manifest is a static import in
`server/extensions/index.js`.

The per-session checklist is the WORKED EXAMPLE throughout — it is the feature
whose fan-out motivated this and the intended first migration — but it is still
an ordinary core feature on its own `checklistEnabled` flag. Nothing below
describes code that ships under `server/extensions/checklist/`; where a manifest
field or a slot is illustrated with it, that is what the migration WOULD look
like.

This records the design as implemented. It went through four rounds: the server
loader and gating, the client slots, the docs, then five further hook points —
core deps for stores and sweeps, per-launch skill gating, a pre-launch dispatch
hook, per-caller MCP tool filtering, and a whole client `view` plus the CSS slot
— added once a second candidate migration found the API had no seam for any of
them. Where the original plan and the code differ, the code is described here.

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
`dir` (from `import.meta.url`) and a default manifest. Sketched below as the
checklist would declare itself — no such directory exists yet:

```js
export const dir = fileURLToPath(new URL('.', import.meta.url));
export default {
  id: 'checklist',                 // /^[a-z][a-z0-9-]*$/, unique
  label: 'Per-session checklist',  // settings toggle label
  help: 'What the feature is, and what survives a toggle. No timing — see extensionFlipNote.',
  defaultEnabled: true,
  dir,
  stores:   { checklist: ({ core }) => new ChecklistStore() },  // factories, instantiated once by index.js
  handlers: [ /* control-WS handlers {type, handler} */ ],
  tools:    [ /* MCP tools {name, description, inputSchema, handler} */ ],
  skills:   ['checklist'],          // agent-skills/skills/<name>
  skillsFor: ({ sessionId, entry, phase, skills, stores, core }) => skills,  // per-launch narrowing
  hideTool: ({ caller, tool, stores, core }) => false,   // per-caller MCP veto
  graph:    ({ stores }) => ({ checklists: stores.checklist.snapshot() }),
  session:  { onPurge: ({ sessionId, stores, core }) => stores.checklist.forget(sessionId) },
  sweeps:   [ /* {id, everyMs, run({stores, core, rebuild, broadcast, deliver})} */ ],
  client:   'public/index.js',      // must resolve inside <dir>/public/
  styles:   'public/checklist.css', // same, and loaded/unloaded with the module
};
```

`core` is `{ sessionManager, taskStore, memoryStore }` — the singletons an
extension may need but can never import (the leaf rule below). It reaches a
store factory, a session hook and a sweep, which is what lets a manifest own a
runner that has to tick sessions or read task memory: a factory called bare
could not be constructed at all. Extension stores are therefore instantiated
*after* those three exist in `index.js`, not beside the loader.

`validateManifest` runs at boot and throws with the extension id in the message
for: a bad or duplicate id, a tool without `name`/`handler`, a handler without
`type`/`handler`, a store that is not a factory, a non-function `skillsFor` or
`hideTool`, an unknown `session` hook name (the known set is `SESSION_HOOKS`:
`onBeforeDispatch`, `onArchive`, `onFork`, `onPurge`, `onDispatch`,
`onResume`), a sweep without a positive finite `everyMs`, and a `client` or
`styles` path that does not resolve inside the manifest's own `public/`.
`server/index.js` catches any loader error, logs it and exits 1, the same posture
as the instance lock.

## Loader outputs

`loadExtensions({ cfg, builtin, coreToolNames, coreHandlerTypes })` walks
`BUILTIN` once and returns:

| key | contents | enabled only? |
|---|---|---|
| `list` | `[{id, label, help, defaultEnabled, enabled}]` for every builtin — `enabled` here is the BOOT value, which `extensionsForGraph` carries onto the graph as `bootEnabled` beside a live re-read | no |
| `stores` | `{name: factory}` | yes |
| `handlers` | control-WS handlers | yes |
| `tools` | MCP tools | yes |
| `allowedToolNames` | `tools.map(t => t.name)` | yes |
| `skillIds` / `disabledSkillIds` | skill names of enabled / disabled manifests | split |
| `graphContributors` | `[{id, contribute}]` | yes |
| `sessionHooks` | `{onBeforeDispatch: [], onArchive: [], ...}` | yes |
| `skillGates` | `[{id, skills, gate}]` — a manifest's own declared skills plus its `skillsFor` | yes, and only with a `skillsFor` |
| `toolFilters` | `[{id, hide}]` | yes, and only with a `hideTool` |
| `sweeps` | `[{extId, id, everyMs, run}]` | yes |
| `clientManifest` | `[{id, client?: '/ext/<id>/index.js', styles?: '/ext/<id>/x.css'}]` — each key present only when the manifest declares it | yes, and only with one of them |
| `dirs` | `{id: dir}` | yes |

`createSkillGate(ext, bag, onError)` and `createToolFilter(ext, bag, onError)`
compose those two lists into the one function each consumer wants, with the
stores and `core` closed over. Both live in the loader (a leaf) so they are unit
testable without a server; `index.js` binds them.

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
(`deps.ext.*` for MCP tools, `ctx.ext.*` for control handlers). Both bags are the
same `extBag = { stores, list, deliver, core, hideTool }` object in `index.js`.

`deliver` is the second thing on that bag for the same reason `stores` is the
first: an extension cannot reach a pane itself. It is `createExtDeliver`
(`server/ext-deliver.js`) bound over `message-delivery.js` and the target
resolvers, which is why `extBag` is now built below `createTargets` rather than
at the top of `index.js`. Sweeps get it in their run args too, that being the
shape of extension that most wants it.

The signature is `deliver(sessionId, text)` — two arguments, no options — and
that narrowness is the access control, the same reasoning as the checklist tools
taking no `session` parameter. `deliverMessage`'s `imagePaths` are absolute paths
handed straight to a pane, safe only because `paste-store.js` mints and
existence-checks them inside one session's own pastes dir; `clearComposer`
empties a pane before pasting and means exactly one thing (the chat view's
Esc-then-edit flow, where the wrangler's own interrupt put the text there).
Neither is something an extension may pass through, and a bad id or blank text
comes back as an `error` result rather than a throw. The routing is
`deliverMessage`'s as-is — paste into a live pane, wake a dormant/suspended card
and deliver after the relaunch, refuse an archived one — reported back as
`{mode: 'live'|'dormant'}` or `{mode: 'error', error}`. The one thing added for
this caller is `reason`, threaded into `resume()`: an extension's wake logs as
`reason=extension`, never `message`, because that log line exists to name what
woke a card. It is not per-extension — the bag is one object shared by every
manifest, and the loader is the only thing that knows which manifest a tool came
from.

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
those loaded at all and cannot be turned on without a restart. Which half of a flip just landed is told on the settings row itself, after the
flip: `extensionFlipNote` (`public/settings.js`) picks one of three lines from
`{enabled, bootEnabled}`, where `bootEnabled` is the loader's snapshot value
carried on the graph beside the live read. The three are the whole state space —
gone from the board (running sessions keep the tools until their next resume),
back on the board (they get them at their next resume), and on in config but off
at boot, the only one that asks for a restart. `setExtensionDefs` no longer
appends a blanket restart sentence to a manifest's `help`: it was false for the
tick-level half, and a static line cannot know which direction was taken. A
manifest's `help` describes the feature and what survives a toggle.

A feature migrating onto a manifest retires its own flag, and its stored value
has to be carried over to `extensions.<id>`. Nothing has been retired yet, so
there is no migration table; the first migration adds one.

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

1. `getExtensions({ coreToolNames, coreHandlerTypes })`, then — after
   `sessionManager`, `taskStore` and `memoryStore` exist — instantiate every
   store factory once into `extStores`, each called with `{ core }`.
2. `assertGraphKeys` on each contributor's output against `RESERVED_GRAPH_KEYS`
   (every key `rebuildOnce` sets itself). Checked once at boot because the
   rebuild is a ~4 s tick where nothing may log or throw.
3. Bind `ext.sessionHooks` onto `sessionManager._extHooks`, closing over
   `extStores` and `core`, and `createSkillGate(...)` onto
   `sessionManager._extLaunchSkills`.
4. MCP deps and WS ctx both carry `ext: extBag`, whose `hideTool` is
   `createToolFilter(...)` — null when no manifest declares one.
5. `rebuildOnce` sets `graph.extensions` from `ext.list` and then
   `Object.assign`s each contributor's output onto the graph.
6. The connect path sends `{ type: 'extensions', list: ext.clientManifest }`
   right after `config`, before the first graph.
7. `main()` starts one unref'd interval per sweep, errors logged with
   `[ext:<extId>:<sweepId>]`.

## Session lifecycle hooks

`SessionManager._extHooks` holds an array per hook name; `_fireExtHooks` runs
them sequentially, catches and logs each throw, and never aborts the core
operation. Fire sites: `onBeforeDispatch` in `dispatch()` (see below),
`onArchive` in `archive()` (unawaited, with `wasArchived`), `onFork` after the
fork entry is saved, `onPurge` from `forget()` (fire-and-forget; `forget` stays
synchronous), `onDispatch` after the new entry is saved, `onResume` at the end
of `_doResume` (not `resume()`, whose coalescing would fire it twice for one
relaunch). Hooks default to empty so every pre-existing SessionManager test
stays inert.

`onBeforeDispatch` is the only one that runs while the session exists nowhere,
and it is `await`ed: the card id, cwd and worktree are settled, but no entry has
been saved and no pane started. That window is the point — an extension that
persists something the agent's very first tool call depends on (a receipt that
needs an owner before the agent can file against it) cannot use `onDispatch`,
which fires after the entry is saved and therefore after the process is already
running. It gets the dispatch's own shape — `{sessionId, cwd, agent, intent,
model, effort, worktree, workflow, spawnedBy, parentSession}` — because there is
no entry to hand it. A throw is logged and the dispatch continues.

A manifest declares only the hooks it needs. The checklist, as and when it
migrates, would declare only `onPurge`: its lifecycle is by construction —
resume keeps the list, a fork starts empty, archive keeps it, only a purge
forgets — so the ABSENCE of `onFork`/`onArchive` is itself worth a test in that
manifest's own directory.

## Per-launch skill gating

A manifest's `skills` list is all-or-nothing: a disabled extension's skills drop
out of the mandatory nudge and the Codex catalog for every session. A feature
whose launches are of two kinds — an automation run versus an ordinary one —
needs the same call made per session, which is what `taskMemoryEnabled`'s
hand-threaded boolean does for the one non-extension case.

`skillsFor({sessionId, entry, phase, skills, stores, core, ...})` is handed its
own extension's declared skills and returns the subset active for this launch.
`createSkillGate` intersects the answer with `skills` and returns what is left
over, so a gate can only ever narrow its OWN manifest's list — naming another
extension's skill (or `task-memory`, which is not an extension at all) does
nothing. A throwing gate suppresses nothing for its extension and never touches
another's: a bug here must not strip a real launch.

`sessionManager._extLaunchSkills` is the seam, consulted by dispatch, resume and
fork BEFORE the adapter builds the command — in dispatch, deliberately after
`onBeforeDispatch`, so a gate can read back what that hook just persisted. Its
answer threads down as `disabledSkills`, an array beside `taskMemory`, through
`buildLaunch`/`buildResume`/`buildFork` on both adapters into
`mandatorySkillPrompt` and `codexSkillCatalog`. `phase` is `dispatch` | `resume`
| `fork`; `entry` is null at dispatch (there is none yet), the existing entry at
resume, and the PARENT's at fork (a fork's own entry is written after launch).

## Per-caller MCP tool filtering

The one extension surface that shapes tools an extension does not own — the case
is a session KIND that must not be offered `spawn_session`. `hideTool({caller,
tool, stores, core})` is a **veto**, not a rewrite: `createToolFilter` asks each
one and the tool stays listed unless some filter says otherwise.
`buildMcpServer` (`server/mcp/server.js`) applies `deps.ext.hideTool` to
`activeTools()` per request, so the narrowing is genuinely absent from
`tools/list` for that caller and present for every other.

It fails OPEN: a throwing filter hides nothing and is logged. This is a UX
narrowing over an advisory identity (`extractCaller` is not authentication — the
origin gate is what accepts a request), so a bug must degrade to the full tool
list rather than leave every session unable to do anything. `--allowedTools` is
baked into launch argv and is unaffected: granting a tool the listing does not
advertise is inert.

## `/ext/<id>/*` route

`http-handler.js` takes `extensionAssets(id) => dir | null`, which `index.js`
implements as a lookup in `ext.dirs` (enabled extensions only). An unknown or
disabled id is a 404; the rest of the path is resolved with `path.resolve`
against `<dir>/public` and refused with 403 if it does not stay under that
prefix (`join(normalize())` would fold a climbing `..` back inside). Served with
`Cache-Control: no-store`, GET only, same posture as `public/`.

## Client slots

`public/slots.js` declares `SLOT_NAMES = ['panel.section', 'panel.metaChip',
'card.pill', 'view']` and `createSlots({ document, storage })` with `register`,
`forExtension(id)` (a registrar bound to one id), `mountInto(slot, hostEl, api)`,
`syncHosts(slot, entries, api, graph)`, `update(slot, session, graph)`,
`removeExtension(id)` and `contributions(slot)`. A new slot needs an entry in
`SLOT_NAMES` and a host in `app.js`.

- Every contribution owns one element per host element — `c.mounts` is that
  host→element map — and mount-once is per host element identity.
  `#panel-sections` is stable and mounts once; `renderPanel`'s chips row is
  rebuilt via innerHTML each render, so its `.sess-meta-ext` host is re-mounted
  each time.
- The two panel slots have ONE host each and go through `mountInto` + `update`.
  `card.pill` has one host PER CARD and goes through `syncHosts`, whose
  `entries` are `[{host, session}]` for every host the slot should occupy after
  this render: it mounts the new ones, updates each element with ITS OWN card's
  session (the one thing `update` cannot do, knowing only one), and tears down
  by OMISSION — a card that has gone is simply a host that isn't in the list.
  Which hosts are gone is the caller's word, never a DOM probe: the caller has
  just rendered, so it knows, and `isConnected` would make the reconciliation
  untestable against a plain element stub.
- `mountInto` is that same reconciliation with a one-host set, which is what
  keeps the chips-row teardown working: this host in, every other host out.
- `view` is the third shape: a whole top-level pane beside the board and Search,
  with ONE host per contribution. It goes through `syncHosts` too, but each
  entry carries `only: {extId, id}` — every other slot's host holds every
  contribution (a card's chip row shows all the pills), while a view's host IS
  one contribution's view and must hold nothing else. `sync()` therefore
  computes its keep-set PER contribution: a host nobody addressed this round is
  not a host to evict from, it is one that was never that contribution's.
  A `view` contribution must carry a `label` (`REQUIRED_FIELDS`), because the
  board draws its rail button before it has a host at all; `contributions(slot)`
  carries `label`/`icon` back for exactly that, and omits both keys where a slot
  needs neither.
- `app.js`'s `renderExtViews()` derives all three pieces of chrome from what is
  registered right now — a `.layouts` rail button, a `.ext-view` host under
  `#ext-views`, and a `#view=ext:<extId>:<id>` hash route — and is called from
  `syncClientExtensions`, the one place that learns an extension has loaded or
  been switched off, never from a render path (this chrome changes on a toggle,
  not on a graph tick). The compound key is what keeps two extensions (or one
  extension's two views) from colliding in `currentView` and in the hash.
  `hashView` refuses an `ext:` key that is not registered, so a stale bookmark
  lands on the board rather than a blank pane, and `renderExtViews` re-reads the
  hash once a view registers — which is what makes a deep link survive the load
  race. Switching to a view deselects the session, same rule as Search and for
  the same reason (an attached terminal behind a full-width pane is invisible
  and still 80 columns wide when you come back). A view that disappears while
  you are looking at it falls back to the board. The icon is markup from the
  extension's own module, the same trust level as the module itself, which
  already owns a whole pane; a view with none gets its label's initial.
- The `card.pill` host is `.card-meta-ext`, rendered by `cards.js`
  (`cardPillHostHtml`) between the core chips and the right-aligned links — the
  same position in the row as the panel's `.sess-meta-ext`. Empty and
  unconditional: `cards.js` is a pure string builder that knows nothing about
  which extensions are loaded. On `.session-card` only — a `.worker-row` is a
  one-line spine row with no chip row to host anything and a `.snoozed-row` is
  not a card, while a full-view child gets one because it renders through
  `sessionCardHtml` like any card.
- `app.js`'s `mountCardPills(el)` maps each host to its session by the card's
  `data-sid` and calls `syncHosts`. It is called from `wireGridEvents`, where
  BOTH render paths (`renderGrid`, `renderFocusedTile`) already end, so the two
  sites cannot drift. A host whose `data-sid` is no longer in the graph is
  skipped rather than mounted with a null session. The board is not re-rendered
  while it is hidden, maximized or has a card menu open
  (`renderGridIfVisible`), so a freshly loaded extension's card pills appear on
  the next board render — its panel contribution is asked for immediately, a
  card pill waits a tick.
- Hosts (`#panel-sections`, `.sess-meta-ext`, `.card-meta-ext`, `#ext-views`)
  and the per-contribution wrapper (`.ext-slot`) are `display: contents`, so an
  extension's element lays out as if it were the host's own child. `.ext-view`
  is the one exception: a top-level view is a `<main>` flex item in its own
  right (same shape as `#search`), so it needs a real box.
- `mount`/`update`/`unmount` each run under try/catch; a throwing contribution is
  removed — every element it has, in every host, so a card pill that throws on
  one card leaves none behind on the others — and reported, and the rest of the
  board carries on.
- Each extension's `api` is app.js's base (`send`, `selectedSessionId`,
  `requestPanelRender`) plus a `namespacedStorage('ext.<id>.')` wrapper.
  `storage.raw(key)` escapes the prefix for a key that predates the API (a
  migrating feature's own, like the checklist's `wrangler.checklistOpen`); a new
  key has no reason to use it.

`public/extensions.js`'s `createClientExtensionLoader(slots)` imports each
`client` URL as an ES module, requires `default.register(slots)`, and is
idempotent per id across reconnects. A failed load is reported, its
registrations removed and the id released so the next connect retries.

A manifest's `styles` is attached as a plain `<link>` in `document.head` — not
injected text, so the browser dedupes and caches it, and (the point here)
removing the rules again is dropping one node rather than bookkeeping which
selectors belonged to whom. It goes on BEFORE the module import, so a module's
first render already has its rules, and comes off in `unload` and on a failed
import, so a toggled-off extension leaves no rules styling elements the core
still draws. `client` may be absent for a styles-only extension and `styles` for
the common case of a module with no CSS; an announcement carrying NEITHER is
malformed and skipped rather than marked loaded, which would swallow the real
entry on a later connect.

A client module lives under its own extension's `public/` (say
`server/extensions/checklist/public/index.js`, with `checklist-dom.js` beside
it) and registers into whichever slots it wants — the checklist's panel into
`panel.section`, its collapsed disclosure chip into `panel.metaChip`. Such a
module must import the board's own modules by ABSOLUTE URL (`/icons.js`),
because it is served from `/ext/<id>/` and a relative import resolves under
that prefix and 404s.

## Settings

`public/settings.js` has an Extensions tab whose rows are built by
`setExtensionDefs(graph.extensions)` on every graph push: one `ext:<id>` toggle
per extension, `scope: 'server'`. `app.js`'s server get/set bridge handles the
`ext:` prefix generically (read back from `graph.extensions`, write via
`extension-enabled`), so a new extension needs no settings edit and no new rung.

## Adding the first (or next) extension

1. Create `server/extensions/<id>/index.js` exporting `dir` and the manifest;
   move the feature's store, handlers, tools and (if any) client module under it.
2. Add the manifest to `BUILTIN`.
3. Carry the retired flag's stored value over to `extensions.<id>`, and delete
   the flag's accessor in `config-store.js`, its `set-<x>-enabled` handler, its
   settings def and its `app.js` rung.
4. Nothing else: registration, launch grant, skill gating, graph, client and the
   settings toggle are derived.

## Deferred

- A mid-prompt hold for `deliver`. A paste lands at the composer's cursor, so an
  extension whose text is an automated NOTIFICATION rather than something a
  human or peer addressed wants the deferral the server's own pane pastes use
  (`pane-deferral.js`). `deliver` is the addressed primitive and cannot tell the
  two intents apart, so that gate belongs to a second hook or an explicit
  opt-in, not to this one.
- Migrating the first feature. The checklist is the intended one — its store,
  handlers, four MCP tools, skill, graph snapshot and client panel map onto the
  manifest one for one — followed by task-memory and archive-review. Each keeps
  its own flag (and task-memory its special case in `activeSkillEntries`) until
  then. Until the first one lands, `BUILTIN` is empty and nothing exercises the
  API end to end but its tests.
- Moving a migrated feature's rules out of `public/styles.css` onto the
  manifest's `styles`. The slot exists; nothing uses it yet.
- Turning an extension ON live when it was OFF at boot. Its store, handlers,
  graph contribution and client asset are all decided by `loadExtensions`, so
  the panel would mount backed by nothing. Making that work means loading every
  extension unconditionally and checking `enabled` at each call site instead —
  a change to the loader's contract, not a patch. (Turning one OFF live, and
  back on within the same boot, both work today.) `--allowedTools` is baked into
  a session's launch argv regardless, so a running session can never gain or
  lose tools without a relaunch.
