# Extensions API

**Status:** implemented; `BUILTIN` is empty
**Date:** 2026-09-11
**Scope:** an in-repo extensions API that lets an optional feature be declared as
one manifest and gated as a unit, instead of growing its own flag and fanning it
out by hand. No feature is migrated onto it yet — this lands the API, its seams
and its tests; the first manifest is the proof. An in-repo manifest is a static
import in `server/extensions/index.js`; installed third-party extensions are
discovered under `<DATA_DIR>/extensions/` and appended to the same list (see
Installed extensions below).

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

## Trust framing

**An extension runs IN-PROCESS WITH FULL ACCESS TO THE USER'S MACHINE** — the
files, the repositories and the agent sessions the wrangler itself can reach.
This is the frame every other decision in this document sits inside, and nothing
in the product or in these docs may imply otherwise.

The `requires` capability list is **disclosure and accident-containment, never a
security boundary.** It says what an extension asked the wrangler for, and it is
what makes an honest mistake land as a structurally absent key rather than a
silent poke at a singleton. It stops nothing: the extension's own code, and every
line of every dependency it pulls in, runs with the server's privileges whether
or not a capability was declared.

The client half is trusted at **exactly the same level** as the server half.
There is no iframe, no sandbox and no origin separation for an extension's
browser module — it is an ES module imported into the board's own page, and it
already owns a whole top-level view.

`npm ci --ignore-scripts` (`install.js`) is a **MITIGATION, not a boundary.** It
stops install-time lifecycle hooks only; every dependency's code runs in-process
the moment the extension is imported. **Installing an extension is exactly as
much trust as `npm install`-ing a package into the server**, and the consent
modal says so in those words (`TRUST_STATEMENT`, `public/extensions-panel.js`).

The audience is colleagues sharing extensions internally. A public ecosystem —
untrusted authors, drive-by installs, code that has to be safe to run because it
was found rather than vouched for — is explicitly **NOT** what this is designed
for, and no amount of validation here would make it so.

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
  skills:   ['checklist'],          // agent-skills/skills/<name>, or <dir>/skills/<name> of its own
  skillsFor: ({ sessionId, entry, phase, skills, stores, core }) => skills,  // per-launch narrowing
  hideTool: ({ caller, tool, stores, core }) => false,   // per-caller MCP veto
  graph:    ({ stores }) => ({ checklists: stores.checklist.snapshot() }),
  session:  { onPurge: ({ sessionId, stores, core }) => stores.checklist.forget(sessionId) },
  sweeps:   [ /* {id, everyMs, run({stores, core, rebuild, broadcast, deliver})} */ ],
  client:   'public/index.js',      // must resolve inside <dir>/public/
  styles:   'public/checklist.css', // same, and loaded/unloaded with the module
};
```

A manifest additionally declares what of the host it touches:

```js
requires: ['board:rebuild', 'deliver'],   // the capability list, see Host API
engines: { wranglerApi: '^1.0.0' },       // the host API range it was written against
```

`requires` selects the keys on the per-extension `host` façade (below).
`engines.wranglerApi` is SHAPE-checked here (`semver.validRange`) and
SATISFACTION-checked by `buildHostApi`, because the loader — a leaf — does not
know which version the server serves.

The singletons an extension may need but can never import (the leaf rule below)
are reached only through that façade. A store FACTORY is the one exception and
gets a deliberately minimal `{ id, log }` bag instead: factories run in
`index.js` before `rebuild`/`broadcast`/`deliver` exist at all, and a store's
constructor has no legitimate need for them — the capabilities are for the tools,
handlers, hooks and sweeps that use the store.

`validateManifest` runs at boot and throws with the extension id in the message
for: a bad or duplicate id, a tool without `name`/`handler`, a handler without
`type`/`handler`, a store that is not a factory, a non-function `skillsFor` or
`hideTool`, a `requires` that is not an array of strings or names a capability
outside `CAPABILITIES`, an `engines.wranglerApi` that is not a valid semver
range, a `skills` name that resolves to neither an in-repo
`agent-skills/skills/<name>` nor the manifest's own
`<dir>/skills/<name>/SKILL.md` (and one that resolves to BOTH, which would be a
shipped directory shadowing a wrangler skill), an unknown `session` hook name (the known set is `SESSION_HOOKS`:
`onBeforeDispatch`, `onArchive`, `onFork`, `onPurge`, `onDispatch`,
`onResume`), a sweep without a positive finite `everyMs`, and a `client` or
`styles` path that does not resolve inside the manifest's own `public/`.
`loadExtensions` catches every one of those per extension and quarantines that
manifest rather than letting the throw out — see Quarantine below, which
replaced this document's earlier exit-1 posture.

## Manifest additions

Three optional prose fields — `description`, `author` and `homepage` — are what
the consent modal and the installed-extension settings row have to show about
code that did not come from this repo. All three are validated as strings when
present and checked for nothing else; they are third-party data and every
consumer renders them via `textContent`.

For an EXTERNAL extension the manifest `id` **must equal its directory name**
(checked by `discoverExternal`, not by `validateManifest` — an in-repo manifest's
directory is the repo's own business). A mismatch is not cosmetic: the provenance
record, the `/ext/<id>/` asset route and the uninstall path are each keyed on one
of the two names, so they would silently disagree about what is installed.

## Loader outputs

`loadExtensions({ cfg, builtin, coreToolNames, coreHandlerTypes })` walks
`BUILTIN` once and returns:

| key | contents | enabled only? |
|---|---|---|
| `list` | `[{id, label, help, defaultEnabled, enabled, requires, range, storeNames, handlerTypes}]` for every builtin — `requires`/`range`/`storeNames` are the façade's build inputs (`index.js`, not this leaf, is what can build one) and `handlerTypes` is what the BOARD binds an extension's client `send` to — `enabled` here is the BOOT value, which `extensionsForGraph` carries onto the graph as `bootEnabled` beside a live re-read | no |
| `stores` | `{name: factory}` | yes |
| `handlers` | control-WS handlers, each tagged `extId` | yes |
| `tools` | MCP tools, each tagged `extId` | yes |
| `allowedToolNames` | `tools.map(t => t.name)` | yes |
| `skillIds` / `disabledSkillIds` | skill names of enabled / disabled manifests | split |
| `graphContributors` | `[{id, contribute}]` | yes |
| `sessionHooks` | `{onBeforeDispatch: [{extId, fn}], onArchive: [...], ...}` — tagged, since each hook needs its own façade | yes |
| `skillGates` | `[{id, skills, gate}]` — a manifest's own declared skills plus its `skillsFor` | yes, and only with a `skillsFor` |
| `toolFilters` | `[{id, hide}]` | yes, and only with a `hideTool` |
| `sweeps` | `[{extId, id, everyMs, run}]` | yes |
| `clientManifest` | `[{id, client?: '/ext/<id>/index.js', styles?: '/ext/<id>/x.css', handlerTypes?: [...]}]` — each key present only when the manifest declares it | yes, and only with one of them |
| `dirs` | `{id: dir}` | yes |

`createSkillGate(ext, hostApiFor, onError)` and `createToolFilter(ext,
hostApiFor, onError)` compose those two lists into the one function each consumer
wants. They take a `hostApiFor(extId)` LOOKUP rather than one shared bag, so each
gate is called with `{ ...context, host }` — its own extension's façade and
nothing else. Both live in the loader (a leaf) so they are unit testable without
a server; `index.js` binds them.

The `extId` tag on every tool, handler and session hook is what makes a
per-extension façade possible at the frame boundary: `mcp/server.js` and
`control/router.js` branch on it, and a tagged frame gets the façade while an
untagged (core) one keeps `deps`/`ctx`.

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
agent adapters (`server/agents/*`), and both import the loader. So
`server/extensions/index.js`, every manifest and everything a manifest imports
must stay leaf-compatible: no import of `session-manager`, `state-reader`,
`tmux-scraper`, `index.js` **or `server/host-api/**`**.
`server/extensions/index.test.js` asserts this over the real `BUILTIN` with a
static regex over import lines. (`semver` is an npm package, not a server module,
so importing it breaches nothing — the rule is about reaching back into the core.)

`server/host-api/**` is the non-leaf half and is imported ONLY by
`server/index.js`. The direction being one-way is exactly why the LOADER cannot
build façades: a capability builder binds singletons the loader may not import.
The loader reports `requires`, the range and each manifest's store names;
`index.js` builds.

`host.deliver` is the `deliver` capability, and it exists for the same reason the
whole façade does: an extension cannot reach a pane itself. It is
`createExtDeliver` (`server/ext-deliver.js`) bound over `message-delivery.js` and
the target resolvers, which is why the façades are built below `createTargets`
rather than at the top of `index.js`.

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
`reason=ext:<id>`, never `message`, because that log line exists to name WHAT
woke a card. It is bound PER EXTENSION (one `createExtDeliver` per façade), which
is the gain over the pre-façade shared bag's one `reason: 'extension'`.

## The leaf-import scan

`discoverExternal` refuses to load an installed extension whose own `.js` files
statically import a forbidden module (`FORBIDDEN_IMPORTS`, `external.js` —
session-manager, state-reader, tmux-scraper, the server entry, `host-api/`).

**This is a CORRECTNESS rule, not a security one**, and it is trivially bypassed
by `await import(...)` at run time. It is not trying to stop hostile code; per
the trust framing there is no boundary here to enforce. It catches the honest
mistake, and it earns its place because of the blast radius: `server/extensions/**`
is imported by `client-config.js` and `agent-skills.js`, which the agent adapters
import, so a static import of session-manager closes a real module cycle and
**nothing comes up at all** — far worse than one broken extension, which is the
failure this whole posture is built to contain.

The scan reads only the extension's OWN files: `node_modules` is skipped (a
dependency is third-party code that legitimately contains anything, and it cannot
be static-imported into the server's graph except through the manifest) and each
file is size-bounded, since this runs at boot for every installed extension.

`FORBIDDEN_IMPORTS` is **exported from `external.js` and imported by
`index.test.js`**, which asserts the same list over the in-repo manifests — one
array, so the runtime scanner and the test cannot drift.

## Host API

`buildHostApi({ id, requires, range, ...wiring })` (`server/host-api/index.js`)
returns the frozen `host` object an extension's tools, handlers, hooks, sweeps
and gates are handed. One builder per capability lives in `host-api/v1.js`
(`V1_BUILDERS`), and those builders are the only place a singleton is touched on
an extension's behalf. Each is a thin bind over a primitive the core already
owns — the point is a declared, closed vocabulary, not a second implementation of
session lifecycle.

The 19 v1 capabilities:

| capability | surface |
|---|---|
| `sessions:read` | `host.sessions.list()` / `.get(id)` / `.forTask(taskId)` → **projections** |
| `sessions:wake` | `host.sessions.wake(id)` → `resume` with `reason: 'ext:<id>'` (forced) |
| `sessions:archive` | `host.sessions.archive(id, { cascade })` |
| `sessions:spawn` | `host.sessions.spawn({cwd,intent,agent,model,effort,autoCompactTokens,parentSession,worktree,addDirs,taskId,autoMergeOnPass,autoFixPrChecks})` → `dispatch`, returning `{sessionId,tmux,cwd,worktree}` |
| `sessions:kill` | `host.sessions.kill(id)` — `reason` forced to `ext:<id>` |
| `tasks:read` | `host.tasks.list()` / `.get(id)` / `.forSession(id)` → projections |
| `tasks:write` | `host.tasks.create/rename/assign/unassign` |
| `memory:read` | `host.memory.read(taskId)` / `.has(taskId)` |
| `memory:append` | `host.memory.append(taskId, text)` — **append only** |
| `deliver` | `host.deliver(sessionId, text)` — per-extension `createExtDeliver` |
| `board:rebuild` | `host.rebuild()` |
| `board:broadcast` | `host.broadcast(payload)` — `type` forced to `ext:<id>` |
| `terminals:create` | `host.terminals.create({cwd, command})` |
| `schedules:read` | `host.schedules.list()` / `.get(id)` |
| `schedules:write` | `host.schedules.create/update/remove` — straight through `schedule-store`, whose `validateAction` is the third model-validation door |
| `mail:read` | `host.mail.unread(sessionId)` / `.list(sessionId)` |
| `mail:send` | `host.mail.send(to, text)` — `from` forced to `ext:<id>` |
| `usage:read` | `host.usage.byCard()` → `Promise<[{cardId, usd, estimatedUsd}]>`, every card's spend summed over every transcript/day it owned, via `usage-scan-memo`'s `cachedScan(scanAllDaily)` (never a scan of its own); `estimatedUsd` is the Codex-estimate slice of `usd` |
| `sessions:bill` | `host.sessions.bill(sessionId, liveSessionId)` → `boolean` — `recordPriorLiveSessionId`: adds a headless conversation to the card's `priorLiveSessionIds` so the cost scanners bill it there; never touches `liveSessionId`, so nothing will ever resume into it |
| `sessions:interrupt` | `host.sessions.interrupt(id)` → `Promise<boolean>` — Escape into the card's live pane (what the chat Stop button sends); `false` with no pane, never wakes one, and does not check the card is working |

Always present, no capability required: `host.id`, `host.version`
(`HOST_API_VERSION`), `host.stores` (its OWN stores only — narrowed by the
manifest's store names, where the pre-façade `extStores` was one flat object
every manifest shared) and `host.log(...)` (through `server/log.js`, prefixed
`[ext:<id>]` into the first argument only when that is a string, so an `Error`
stays its own argument).

An undeclared capability's key is **structurally ABSENT**, not a method that
throws: `'sessions' in host` is false for an extension that declared none. The
façade and every nested sub-object are frozen.

**Three forced values** — `broadcast`'s `type`, `mail.send`'s `from`, and
`wake`/`kill`'s `reason`. All three are set by the builder from the closed-over
extension id and are not caller-passable, so an extension can never impersonate
the core or another extension on any of them. This is `createExtDeliver`'s
narrow-signature rule generalised: narrowness of signature IS the access control,
because a runtime check a caller can pass a value through is not a control.

`sessions:spawn` **may** set `parentSession` to a card the extension did not
create — a resolved decision, not an oversight. Board nesting is not ownership,
and `attach_session` already re-parents anything. It may **not** set
`spawnedBy`: that is core's lineage field, stamped by the `spawn_*` tools from
the calling session's own id, and an extension has no id of its own to claim
there — any it named would be another card's.

Every spawn option is **type-checked in the builder and refused by name**, which
is the exception to "a thin bind over a primitive the core already owns":
dispatch is forgiving by design, so a mistyped `addDirs` launches with no
grants and a non-object `worktree` launches in the plain cwd, and both read to
the extension author as an option that did nothing. An unknown key inside
`worktree` is refused for the same reason — `baseRef` ignored in place of
`base` is a branch cut from the wrong commit, which nothing downstream can
detect.

Three of those options exist because an extension otherwise has to reimplement
the launch rather than ask for it. `worktree: {branch, base, auto, folderName}`
makes the WRANGLER cut it (`resolveWorktree` → `createWorktree({baseRef})`), so
the card carries a real worktree record — the badge, the archive-time cleanup
offer and core's `name_branch` all key off that, and an extension cutting its
own and launching into it as a plain cwd gets none of them. `taskId` is the
whole task binding, not a shorthand for `tasks.assign` afterwards: it binds the
memory symlink BEFORE the pane starts, and only Claude follows a later repoint
— Codex resolves its writable root once at launch, so an assign after the fact
leaves it writing into scratch memory. `autoFixPrChecks` has no dispatch
argument (it is a tri-state whose absent value means on) and so goes through
`setAutoFixPrChecks` immediately after launch, which is what lets an extension
driving its own PR automation switch core's off.

**Projections** (`host-api/project.js`): `sessions:read` and `tasks:read` hand
back explicit frozen allow-list COPIES, never the live mapping entry. They
exclude `liveSessionId` and `priorLiveSessionIds` deliberately — a conversation
id is `--resume`-able, so handing one out reaches a conversation outside the
board's own lifecycle (and outside `resolveResumeDir`'s guard). They also include
nothing wanted merely so it can be written back: a mutation belongs behind a
capability method, not behind a read plus a store poke.

**Versioning.** `HOST_API_VERSION` (`host-api/version.js`) is what the server
serves; a manifest's `engines.wranglerApi` is the range it needs. A breaking
reshape adds `v2.js` and keeps `v1.js` as the shim, selected by that range,
rather than editing builders in place.

**Extension tool and handler signatures.** An extension MCP tool is
`handler({ host, caller }, args)` — no `deps`. An extension control handler is
`handler(msg, host)` — no `ctx`. Core tools and handlers keep `deps`/`ctx`
unchanged; `mcp/server.js` and `control/router.js` branch on the loader's `extId`
tag.

**Failure posture**, three tiers:

1. **Quarantine** — a bad `requires`, an unknown capability, or an invalid or
   unsatisfied range: logged naming the extension, and that extension alone is
   disabled for the boot. `buildHostApi` still THROWS as its contract; what
   changed is that `server/index.js` catches per extension instead of exiting.
   This tier originally read `process.exit(1)`; see Quarantine below for why
   third-party manifests made that untenable.
2. **Runtime throw from a façade method** — propagates normally: an MCP tool
   returns an error result, a control handler hits the router's error envelope.
   No swallowing, no per-method try/catch in the façade.
3. **The two advisory gates keep their asymmetry** — `hideTool` fails OPEN
   (hides nothing) and `skillsFor` suppresses nothing. Both are UX narrowings
   over an *advisory* identity (`extractCaller` is not authentication), so a bug
   there must not leave sessions unable to act. Not to be "fixed" for symmetry.

`deps.ext` / `ctx.ext` do not vanish: they keep `list` (the settings panel's read
over every extension) and `hideTool` (a core-owned filter over ALL tools,
including ones no extension owns). Neither is a per-extension capability, so both
stay on the core bag rather than becoming a meta-capability — this is finished,
not a half-done migration.

## Quarantine

**The failure posture, and it OVERRIDES this design's earlier `process.exit(1)`
tier for a bad manifest.** With third-party manifests in the loaded list, one bad
directory must not take the whole board down. So on any failure the entry still
lands in `out.list` as `{ enabled: false, quarantine: '<reason>' }` and
contributes **nothing** — no tools, handlers, stores, graph keys, hooks, sweeps or
client asset. `extensionsForGraph` short-circuits `enabled` in both directions
off it, because config saying "on" over a manifest that contributed nothing would
draw a live-looking toggle over a feature that is not there.

The reasons: a bad manifest (anything `validateManifest` refuses), a duplicate
id, a tool-name, handler-type or store-name collision, an unsatisfiable
`engines.wranglerApi`, an unknown capability, a `requires` widened past its
recorded consent, a failed install, a leaf-rule import violation, a manifest id
that disagrees with its directory name, and an unreadable `index.js`. The ones
detected inside the loader decline to register at all; the ones only the non-leaf
half of boot can see (a store factory that threw, `buildHostApi`'s range check, a
graph contributor claiming a reserved key) go through `quarantineExtension`,
which unregisters by id what `loadExtensions` had already staged.

**Collision order is load-bearing.** Builtins come first and installed extensions
are appended (`primeExtensions`), and every name check is first-come — so a
builtin wins every tie by construction and the EXTERNAL entry is the one
quarantined. Nothing has to arbitrate; the order is the rule.

A quarantined **BUILTIN** additionally raises a persistent board banner with no
"dismiss for today" (`graph.quarantinedBuiltins`, `app.js`): a repo bug that
silently contributed nothing would read as a feature that quietly vanished, which
is the one failure this posture must not produce. Installed extensions are
excluded — their reason belongs on their own settings row, where the Uninstall
and Update buttons are. Adding that producer is why `system-banner.js`'s dismiss
key is now **namespaced by producer**: fd levels are descriptor counts and heap
levels are percentages, and sharing one bare number meant dismissing an fd banner
silently suppressed a 90%-heap one. A legacy bare `{level, until}` is read as the
fd entry it was.

Each quarantine is **one event log line at boot** and nothing per-tick — the
loader's own from `index.js` (which can import `log.js`; the leaf cannot), the
later ones from `quarantineFor`.

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

1. `getExtensions({ coreToolNames, coreHandlerTypes })`, then instantiate every
   store factory once into `extStores`, each called with the minimal
   `{ id, log }` bag (they run before the board primitives exist).
2. Declare `hostApis` (extId → façade) and `hostApiFor` EARLY, and bind every
   boot-time seam over the lookup rather than the façade: session hooks
   (`fn({ ...payload, host })`, losing `stores` and `core`) and
   `createSkillGate(ext, hostApiFor, logError)` onto
   `sessionManager._extLaunchSkills`. All of them fire at run time, long after
   the Map is filled.
3. Once `rebuild`, `broadcast` and the target resolvers exist, build one façade
   per ENABLED extension with `buildHostApi`, each with its own
   `createExtDeliver(deps, { reason: \`ext:${id}\` })` and its own
   `host.stores`. Caught PER EXTENSION: a bad `requires`, capability or range
   logs naming the extension and quarantines it (`quarantineExtension`
   unregisters what the loader already registered for it). Asserted after the
   loop: every still-enabled tagged tool and handler has a façade — a boot-time
   invariant, not a per-frame guard, and a miss there means the quarantine
   bookkeeping left something registered, which IS a core bug and still exits 1.
4. `assertGraphKeys` on each contributor's output — called with
   `{ host, graph: {} }` — against `RESERVED_GRAPH_KEYS` (every key `rebuildOnce`
   sets itself). Checked once here because the rebuild is a ~4 s tick where
   nothing may log or throw.
5. MCP deps and WS ctx carry `ext: extBag` (now `list` + `hideTool` only) plus
   `hostApiFor`, which is what `mcp/server.js` and `control/router.js` select
   with.
6. `rebuildOnce` sets `graph.extensions` from `ext.list` (each entry carrying its
   own `handlerTypes`) and then `Object.assign`s each contributor's output.
7. The connect path sends
   `{ type: 'extensions', list: ext.clientManifest, version: HOST_API_VERSION }`
   right after `config`, before the first graph.
8. `main()` starts one unref'd interval per sweep, each run as
   `s.run({ host })`, errors logged with `[ext:<extId>:<sweepId>]`.

## Boot ordering and `primeExtensions`

`primeExtensions()` is the one **async** door into the loader memo, and the only
one that includes installed extensions — discovery has to `await import()` each
manifest to read it. `getExtensions()` stays synchronous and unchanged, which is
the whole reason the async work is a separate function: otherwise every leaf
consumer (`client-config.js`, `agent-skills.js`, `mcp/tools/index.js`,
`control/router.js`) and, through them, the agent adapters would have to become
async to read a memo that is already filled.

**`primeExtensions` THROWS if the memo is already set.** That is the ordering
guard, and it is the fragile part of the feature: anything that reaches
`getExtensions()` first silently pins a BUILTIN-ONLY board for the life of the
process — installed extensions simply absent, no error anywhere. So
`server/index.js` awaits it at the top of the module, before the MCP registry,
before the control router's lazy handler map, and before any adapter import.

`getExtensions()` deliberately does **not** also throw when called before
priming — a resolved decision, not an omission. It cannot tell a mis-ordered boot
apart from the adapters and the whole test suite legitimately calling it with an
injected `{ builtin }`/`{ cfg }` and no priming at all. The throw above already
fires on exactly the bad case (something got in first), so a second guard would
add a false-positive surface and no coverage.

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
model, effort, autoCompactTokens, worktree, workflow, spawnedBy, parentSession}` — because there is
no entry to hand it. A throw is logged and the dispatch continues.

A manifest declares only the hooks it needs. The checklist, as and when it
migrates, would declare only `onPurge`: its lifecycle is by construction —
resume keeps the list, a fork starts empty, archive keeps it, only a purge
forgets — so the ABSENCE of `onFork`/`onArchive` is itself worth a test in that
manifest's own directory.

## Skills an extension ships

A manifest's `skills` names either one of the wrangler's own
`agent-skills/skills/<name>` — all it could name at first, and still how it
gates one — or a skill it SHIPS at `<dir>/skills/<name>/SKILL.md`, in exactly
the in-repo layout (sidecar `WRANGLER.md` included). `agent-skills.js`'s
`allSkillEntries` is where the two are merged, off the loader's list rows
(`id`/`dir`/`skills`) on every call, so an install adds a skill and an uninstall
takes it away at the next launch with nothing to invalidate.

Names are one flat namespace keyed by the frontmatter `name`. The in-repo skill
wins any clash and the second extension to ship a name is quarantined — the
loader claims a SHIPPED name in `_reg.skillNames` exactly as it claims a tool
name, and releases it on unregister. An in-repo name claims nothing: several
manifests may gate `checklist`.

The two always-on channels need nothing new (the entry carries its own absolute
`path` and `nudge`), but Claude's discovery does: an extension's skill is
outside `AGENT_SKILLS_PLUGIN_DIR`, so each ACTIVE one rides as a
`--plugin-dir` of its own (`extensionSkillPluginDirs`, a directory holding a
SKILL.md loads as a one-skill plugin). That list is GATED where the in-repo root
is not, and deliberately: most extension skills carry no `WRANGLER.md`, so
discovery is their only channel and leaving a suppressed one on the command line
would make `skillsFor` decide nothing for Claude. The devcontainer runtime
copies every installed extension's skill dirs in beside the in-repo plugin root
(`launchInputs`), ungated, since the gate has answered by then.

## Per-launch skill gating

A manifest's `skills` list is all-or-nothing: a disabled extension's skills drop
out of the mandatory nudge, the Codex catalog and — when the extension ships it
— Claude's plugin list, for every session. A feature
whose launches are of two kinds — an automation run versus an ordinary one —
needs the same call made per session, which is what `taskMemoryEnabled`'s
hand-threaded boolean does for the one non-extension case.

`skillsFor({sessionId, entry, phase, skills, host, ...})` is handed its
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
tool, host})` is a **veto**, not a rewrite: `createToolFilter` asks each
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
'card.pill', 'view']` and `createSlots({ document, storage, handlerTypesFor,
version })` with `register`,
`forExtension(id)` (a registrar bound to one id), `mountInto(slot, hostEl, api)`,
`syncHosts(slot, entries, api, graph, onBadge)`, `update(slot, session, graph)`,
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
- A `view` may also carry `badge()`, a function returning a count for the rail
  button — the one affordance a contribution that owns a whole pane still
  cannot draw itself, because the rail is the board's chrome. CORE owns the
  element (`.ext-view-badge`, a span inside the button `renderExtViews` built,
  written with `textContent` and capped at `99+` because the button is 40px
  wide) and the extension owns only the number; smuggling one into the `icon`
  markup would mean positioning against a button core lays out, untested by
  anything in core and re-invented by the next extension. Falsy, absent, or
  anything that is not a positive whole count draws nothing, and nothing is
  reported for it (a `badge` that is not a function at all is refused by
  `register`, since that one can only be a typo): this runs on the ~4s tick, where a report would be a report
  per tick (the same silence `dispatchMessage` keeps about a frame nobody is
  listening for).
  It is evaluated by `reportBadges` (slots.js) from `syncHosts`'s optional
  `onBadge` — so on the VIEW TICK, every graph, even while another view is on
  screen (`setView` only hides a view's host), which is what makes a needs-you
  count visible from anywhere. It runs AFTER mount and update, so a badge reads
  what the update it shares a tick with just settled, and under the same
  try/catch-and-drop rule: a throwing badge removes the contribution exactly as
  a throwing update does. Only a caller that passes `onBadge` asks at all, which
  today is `app.js`'s `updateExtViews` and therefore only the `view` slot.
  A contribution with no `badge`, one with no element, and one just dropped all
  report NOTHING rather than a zero; `updateExtViews` clears every rail button
  it did not hear about, one rule covering all three, so a count can never
  outlive what produced it. The count also goes into the button's `aria-label`,
  which is its whole accessible name (the icon is decorative markup).
  `HOST_API_VERSION` 1.7.0 is what a manifest declares to say it needs this: as
  with 1.2.0's `onMessage`, there is no new server-side key, and an older server
  neither errors nor quarantines — it just never calls `badge`, and the declared
  range is the only thing that tells the two servers apart.
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
  `requestPanelRender`, `openSession`) plus a `namespacedStorage('ext.<id>.')` wrapper.
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

- `apiFor(extId)` mints the per-extension client façade, the browser mirror of
  the server façade's forced-value rule. `send` is **bound to that extension's
  own registered handler types**: a frame whose `type` is not in its
  `handlerTypes` is dropped and reported through `onError`, never sent, so an
  extension's client half cannot drive another extension's — or the core's —
  control handlers. `handlerTypesFor(extId)` defaults to allowing NOTHING, so a
  board that has been told nothing fails closed and reports rather than
  forwarding blind, and it is read at SEND time because the announcement can
  arrive after a contribution has mounted. The api also carries `version` (the
  served `HOST_API_VERSION`), `selectedSessionId`, `requestPanelRender` and the
  namespaced `storage` (with `raw()` retained for `wrangler.checklistOpen`).
- `openSession(sessionId)` (1.8.0) is the one piece of board NAVIGATION an
  extension gets: it switches to the grid and selects the card if it is on the
  board, otherwise pending-selects it, sends the core `resume` frame and toasts
  `Restoring…` — exactly what a Search result's Restore does. It lives on the
  base api because an extension can do none of that itself: its `send` is bound
  to its own handler types, so `resume` is refused, and nothing else reaches the
  view or the selection. `apiFor` refuses and reports a non-id argument the way
  it refuses a foreign `send`. No `openDiff` yet.
- The type list rides BOTH server inputs — the `extensions` connect message
  (which also carries `version`) and `graph.extensions` — because either can
  arrive first; `app.js` owns the map and hands `createSlots` the lookup.
  `app.js`'s `extApi` keeps the RAW `send`; the binding happens inside `apiFor`,
  which is the only place the extension id is known.

## Settings

`public/settings.js` has an Extensions tab whose rows are built by
`setExtensionDefs(graph.extensions)` on every graph push: one `ext:<id>` toggle
per extension, `scope: 'server'`. `app.js`'s server get/set bridge handles the
`ext:` prefix generically (read back from `graph.extensions`, write via
`extension-enabled`), so a new extension needs no settings edit and no new rung.

## Installed extensions: layout and provenance

An installed extension is one immediate subdirectory of
`<DATA_DIR>/extensions/<id>/` whose `index.js` default-exports a manifest.
**DATA_DIR-relative on purpose**: a `run-dev` isolated instance (a fresh
`AW_DATA_DIR`) starts with no installed extensions the same way it starts with no
sessions, and `server/test-setup.js`'s redirect gives the tests that isolation
for free rather than by a path injection nothing else needs.

`<DATA_DIR>/extensions.json` (`provenance.js`) holds one record per installed
extension, `{ id, originUrl, sha, installedAt, requires, dependencies }`. It is
**deliberately separate from `config.json`**, which keeps the `extensions.<id>`
enable flags unchanged: config.json is hand-edited, and putting it in the path of
an atomic whole-file rewrite on every install buys nothing.

The last two fields are why anything is persisted at all. `requires` on the
record is the **CONSENTED** set — the thing a later version's `requires` is
diffed against, and what discovery re-checks the on-disk manifest has not widened
past. `dependencies` is the flattened `name@version` list taken from the clone's
`package-lock.json` at consent time. Neither is recoverable from the installed
tree, because the tree is always whatever the new version ships: without the
record an update has nothing to diff against.

An extension with **no record** — a hand-dropped directory, which is a legitimate
dev workflow — still loads, and is not gated on consent (placing it there by hand
is its own consent). It is simply not updatable: there is no `originUrl` to
re-clone or `ls-remote` against, and the update check skips it.

## Install flow

Clone → disclose → consent → `npm ci` → move into place → restart. Two control
frames with a human decision between them (`ext-install`, then `ext-consent`),
plus `ext-uninstall` and `ext-check-updates`
(`server/control/handlers/extensions-install.js`).

**All git and npm shelling is confined to `server/extensions/install.js`**, the
way `pr-status.js` confines `gh`: everything the install needs from a subprocess
lives behind injectable runners there, so nothing else may spawn either binary
and a test drives the whole path with no process and no network. The runners are
a MODULE seam and never an option on the incoming frame — a control frame is
browser-supplied, so a `_clone` a client could set would be arbitrary code
execution offered as an API.

The URL goes through a **scheme allow-list checked BEFORE git runs**
(`assertAllowedUrl`): `https://`, `ssh://` and the scp-like `git@host:path`, the
last anchored and character-restricted rather than "has an @ and a colon".
`ext::` is refused because git's ext transport **runs an arbitrary command** as
its transport helper — a real RCE vector, and the URL is the one thing an
installing human supplies. `file://` and bare local paths are refused because
they sidestep provenance entirely: there is no remote to verify or update
against. Anything with whitespace or a shell metacharacter is refused outright
even though the URL never reaches a shell, so no future caller can reintroduce
the hazard by interpolating a stored URL into a command string. The clone then
**disables both protocols in git itself** (`protocol.ext.allow=never`,
`protocol.file.allow=never`, plus `--no-local`), because a clone can follow a
submodule URL or a redirect to a URL this process never screened, and passes the
URL after `--` as its own argv element with no shell.

**`package-lock.json` is MANDATORY**, and its absence refuses the install *before
the disclosure* (`MissingLockfileError`): an unpinned dependency set cannot be
disclosed honestly, so there is nothing to consent to. Consent likewise precedes
any registry fetch — nothing is downloaded from npm until a human has approved
the disclosed list.

### The disclosure is read statically, and the manifest is never imported before consent

An external extension MUST carry a `wranglerExtension` block in its
`package.json` — `{id, label, description?, author?, homepage?, requires?}` —
and `readDeclaration` (`install.js`) reads the consent modal's contents out of
**that**, never out of the manifest module. Two independent reasons, either of
which alone forces it:

- **Security.** Importing `index.js` *executes* third-party code, and the consent
  modal exists precisely to precede that. Disclosing by import ran the code
  before the human had agreed to anything — a worse hole than the documented
  `--ignore-scripts` caveat, which at least only applies once the extension is
  installed and loaded.
- **Correctness.** `npm ci` runs only *after* consent, so at disclosure time the
  clone has no `node_modules` and a manifest importing any dependency cannot be
  imported at all. A lockfile is mandatory, so having dependencies is the
  expected case — this made every non-trivial extension uninstallable.

The block is therefore duplicated between `package.json` and the manifest by
design. `ext-consent` closes that gap once running the code is consented to:
after `npm ci` it imports the manifest, validates it, and holds it to the
declaration (`assertManifestMatchesDeclaration`) — a different `id` would install
into a directory the disclosure never named, and a **wider `requires`** would take
capabilities that were never on screen. Either **fails the install** rather than
quarantining after the fact, because nothing is on disk yet so refusing is free.
The provenance record's consented `requires` is the **DISCLOSED** list, not the
manifest's, because that is what the human approved.

### An abandoned consent is reclaimable

The install lock is held across the human's decision (the staging dir is what a
second install would collide with), but "the human decided" is not the only way a
disclosure ends: closing the modal, reloading the board or losing the socket all
end one with nobody to answer, and the handler is told about none of them. A
disclosure awaiting consent is therefore reclaimable after
`PENDING_CONSENT_TTL_MS` (10 minutes) — the next install sweeps that staging dir
and takes the lock. Without it one abandoned modal wedged **every** install on the
instance until a restart, which is a real dead end rather than the "a restart
cancels nothing meaningful" the in-memory lock is justified by. Reclaim is gated
on *awaiting consent*, never on age alone: a clone or an `npm ci` is genuinely
slow and already bounded by its own `execFile` timeout, so a running install keeps
refusing however long it has taken.

The staging dir is `<DATA_DIR>/extensions/.tmp/<tempId>/` — dot-prefixed so it
lives on the same filesystem as the destination (the rename is atomic) without
discovery mistaking it for an extension — and is removed on cancel and on any
failure at any point, so a half-populated `extensions/<id>/` is never left for
the boot loader to find. **Boot sweeping it (`sweepStaging`) is the only recovery
an interrupted install needs**, which is exactly what lets the
one-install-at-a-time lock be purely in-memory; a restart cancels nothing
meaningful. A second concurrent attempt is **REFUSED, not queued**: two clones
racing into one staging root has no sensible outcome, and a human who pressed the
button twice wants to be told rather than silently made to wait.

Every computed path is resolved and asserted to stay **directly under
`<DATA_DIR>/extensions/`** before any write or delete (`safeExtPath`,
`safeStagingPath`), because the id comes from a third-party manifest.
`isValidExtensionId` already rejects a separator outright; this is the second,
structural check, since one missed id validation on a delete path is a wipe of an
arbitrary directory.

## Update

**An update IS `ext-install` against the recorded `originUrl`** — same clone,
same consent modal, same handler, no second code path. The only difference is
what the modal renders.

It shows **CHANGED** capabilities and **CHANGED** dependencies, not full lists:
on an update the diff is the decision, and a transitive tree can churn by
hundreds of entries that hide it. Direct-dependency changes are listed and the
transitive remainder is a count. Removals can only be filtered to "the package
NAME left the tree entirely" — the provenance record stores a flat list with no
direct/transitive mark, and adding one would help only installs made from then
on — so a removal that is merely the old half of a version bump is left to the
added side to show.

**Re-consent is required ONLY when `requires` widens.** Unchanged or narrowed
proceeds on the recorded consent, because nothing new is being asked for. A
manifest that widens itself in place on disk *after* consent is caught at the
next discovery and quarantined (`unconsentedCapabilities`), which is why that
check lives at boot as well as at install time — editing the file is all it would
take.

"Check for updates" is **one `git ls-remote` per installed extension, on demand
only** — no sweep, no background network, nothing logged. A periodic check would
be per-tick log noise and unasked-for traffic to whatever host an extension came
from. An extension with no provenance record is skipped rather than reported as
up to date.

## Restart semantics and the client half

Newly installed code loads at the **next server start**, exactly like the
existing `enabled && !bootEnabled` case, and the copy reuses
`extensionFlipNote`'s vocabulary (`RESTART_NOTE`,
`public/extensions-panel.js`) rather than inventing a second way of saying "needs
a restart". Uninstall is symmetric: the directory and the record go immediately,
and the code stays live out of the process's module cache until restart — but only
where it was running to begin with, so the confirm copy drops that sentence for an
extension that is turned off or quarantined.

Every one of those notes now carries the **restart button** that finishes the job,
because an uninstall that visibly changes nothing until some later unexplained
restart reads as an uninstall that did nothing. It is offered only where the server
says it can come back: `AW_SUPERVISED=1`, exported by `scripts/wrangler-start.sh`
(what both the launchd plist and the systemd unit exec), surfaced to the client as
`config.canRestart` and enforced by `control/handlers/restart.js`, which refuses
otherwise. Since the server's extension list is a boot snapshot, the client holds
the uninstalled id (and a freshly installed one, which is in no list at all yet) as
pending state and clears it on the next `config` frame — the first frame of every
reconnect, and the only reliable signal that the restart actually happened.

The tab itself is **one list**: builtin and installed extensions render through the
same row, with the toggle, the origin and the actions together, instead of the two
lists that repeated each other's name and description. A row carries name,
description and origin only; the commit and author moved to the consent modal, which
is the screen where they are a decision rather than clutter. `Update…` appears only
once a check has actually found a newer commit, the check says `Checking…` while it
runs, and a settled report ("Up to date.", "Cancelled. Nothing was installed.")
clears itself after a few seconds — it describes a moment, not a state.

**All third-party strings** — label, description, author, homepage, capability
and dependency names, quarantine reasons — go into the DOM via `textContent`
only. That is why `public/extensions-panel.js` exists as a separate module rather
than more rows in `settings.js`, whose own rows are innerHTML plus `esc()`: this
path never has to carry installed-extension data at all.

`homepage` is rendered as a link only when it is `https://`, and as plain text
otherwise — a third-party-supplied href is not worth the navigation surface for a
decoration.

The consent modal has **no Enter-to-approve**, unlike `confirmDialog`. It grants
a process full access to the machine, and that is not a decision a stray keypress
may make.

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
- An explicit store-data purge on uninstall. Uninstall removes the installed
  directory and its provenance record; anything the extension persisted under
  `DATA_DIR` stays, not as a retention feature but because the wrangler cannot
  find it — a store's file is chosen by the extension's own factory and there is
  no wrangler-owned per-extension data dir to sweep. A real purge needs a way to
  enumerate what an extension owns (most likely a declared data directory the
  host hands out, which would make removal trivial), and the confirm copy says
  plainly that the gap exists until then.
- Signature or publisher verification of an installed extension, any registry or
  discovery mechanism, per-extension resource limits, and sandboxing of any
  kind. All four remain out of scope: per the trust framing there is no boundary
  here to harden, and adding a partial one would be worse than none, because it
  would read as a guarantee.
