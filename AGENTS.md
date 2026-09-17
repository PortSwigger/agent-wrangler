# AGENTS.md

## Invariants & footguns

- **Extensions API (`server/extensions/index.js`, `public/slots.js`,
  `public/extensions.js`) — an optional feature is ONE manifest, loaded ONCE at
  boot, and every gate reads the loaded list, never the config.** A manifest
  (`server/extensions/<id>/index.js`, exporting `dir` from `import.meta.url` and a
  default `{id, label, help, defaultEnabled, stores, handlers, tools, skills,
  skillsFor, hideTool, graph, session, sweeps, client, styles}`) is validated at boot (`validateManifest`,
  every throw names the id) and `index.js` exits 1 on a bad one — a manifest
  colliding with a core tool name or handler type is a config error a human must
  see, not something to limp past. Enabled is `extensions.<id>` in config.json
  (`extensionEnabled`, `config-store.js`), and **the two halves of a toggle move
  at DIFFERENT times — the UI on the next tick, everything else at the next
  restart.** `graph.extensions[].enabled` is re-read from config on every rebuild
  (`extensionsForGraph`, NOT `ext.list`'s boot snapshot, which carries only the
  identity/label/help/defaultEnabled that cannot change without a restart), and
  the client mounts or unmounts that extension's slot contributions off it
  (`syncClientExtensions` in `app.js`, the loader's `unload`). That liveness
  matches what a per-feature flag's own per-tick read (`graph.checklistEnabled
  = checklistEnabled()`) already gives the features that still have one:
  **a toggle that changes nothing visible until a restart is a regression, so
  don't collapse this back onto `ext.list`.** Tools/handlers/skills/stores/graph-contributors/client assets
  ARE fixed at load, so an agent's MCP tools follow at its next relaunch, and an
  extension that booted OFF has no store, no handler and no client asset to
  serve — it cannot be turned on live at all and genuinely needs a restart. **Timing is told to a human by
  `extensionFlipNote` (`public/settings.js`) AFTER a flip, never by the
  manifest's `help`** — the row's note picks one of three lines from
  `{enabled, bootEnabled}` (`bootEnabled` being the loader's own snapshot
  value, carried on the graph beside the live read), so it can name the
  restart only in the case that needs one. A static help sentence cannot: a
  blanket "takes effect after the wrangler restarts" was appended to any help
  that didn't mention one, and it is now false for the half of a flip that
  lands on the next tick. A manifest's `help` says what the feature IS and what
  survives a toggle, nothing about when. Sweeps and session hooks run from the
  fixed list.
  Six things are load-bearing. **`server/extensions/**` is imported by the
  `client-config.js` and `agent-skills.js` leaves (which the agent adapters
  import), so every manifest and everything it imports must itself stay
  leaf-compatible — never `session-manager`/`state-reader`/`tmux-scraper`/
  `index.js` **or `server/host-api/**`** (`extensions/index.test.js` asserts all
  of these over the real `BUILTIN` by regex; `semver` is an npm package, not a
  server module, and breaches nothing). **The one-object-for-everyone `extBag` is
  GONE — a tool, handler, hook, sweep or gate reaches the server ONLY through its
  own versioned `host` façade (`server/host-api/`, the non-leaf half, imported
  only by `index.js`), whose keys are selected by the manifest's `requires: [...]`
  list.** That import direction being one-way is exactly why the LOADER cannot
  build façades: a capability builder binds singletons it may not import, so the
  loader only REPORTS `requires`, the `engines.wranglerApi` range and each
  manifest's store names, and tags every tool, handler and session hook with its
  owning `extId` (which is what `mcp/server.js` and `control/router.js` branch on
  — a tagged frame gets the façade, an untagged core one keeps `deps`/`ctx`). The
  loader still takes `coreToolNames`/`coreHandlerTypes` as ARGUMENTS from
  `index.js` for the same leaf reason. `deps.ext`/`ctx.ext` survive with `list`
  and `hideTool` ONLY — both core-owned reads over ALL extensions, not
  per-extension capabilities; that is finished, not a half-done migration.
  The façade is how an extension reaches a pane: `host.deliver(sessionId, text)`
  behind the `deliver` capability (`ext-deliver.js`, bound over
  `message-delivery.js` and the target resolvers, which is why the façades are
  built below `createTargets`), and its **two-argument signature IS the access
  control** —
  `deliverMessage`'s `imagePaths` are absolute paths handed straight to a pane
  (safe only because `paste-store.js` mints them inside one session's own
  pastes dir) and `clearComposer` wipes a human's composer, so neither may be
  passed through; a bad id or blank text is an `error` result, not a throw. It
  wakes a dormant target and refuses an archived one, exactly as a human's send
  does, but logs its relaunch as `reason=ext:<id>` — that line names WHAT woke
  a card, `message` would read as a human pressing send, and the pre-façade
  shared `'extension'` named nothing; it is bound once PER FAÇADE for that. **It is the
  ADDRESSED primitive, NOT a notifier**: an automated nudge off a poll wants
  `pane-deferral.js`'s mid-prompt hold, which nothing here can apply because
  the two intents are indistinguishable at this seam. The memoised `getExtensions()`
  is what lets those leaves derive their lists with no threading; `index.js`
  must call it FIRST, with the core names, or an adapter's parameterless call
  memoises a copy that skipped the cross-registry check (`router.js` builds its
  handler map lazily on the first frame for exactly this ordering reason).
  **The `host` façade is the ONLY route to anything an extension cannot import,
  and three of its values are FORCED from the closed-over extension id and are
  NOT caller-passable** — `broadcast`'s `type`, `mail.send`'s `from`, and
  `wake`/`kill`'s `reason` (all `ext:<id>`), so an extension can never
  impersonate the core or a sibling. Same rule as `deliver`'s two arguments:
  narrowness of signature is the control, because a runtime check a caller can
  pass a value through is not one. An UNDECLARED capability's key is
  structurally ABSENT (`'sessions' in host` is false), never a method that
  throws, and the façade plus every nested sub-object is frozen.
  `sessions:read`/`tasks:read` hand back frozen allow-list PROJECTIONS
  (`host-api/project.js`) that **deliberately omit `liveSessionId` and
  `priorLiveSessionIds`** — a conversation id is `--resume`-able, so handing one
  out reaches a conversation outside the board's lifecycle and outside
  `resolveResumeDir`'s guard; that omission is the most likely thing a future
  contributor "helpfully" adds back. `host.stores` is that extension's OWN
  stores only (narrowed by the manifest's store names), and `memory:append` has
  no `write` sibling on purpose. **A store FACTORY is the one thing that gets no
  capabilities** — a deliberately minimal `{id, log}` bag — because factories run
  before `rebuild`/`broadcast`/`deliver` exist at all and a constructor has no
  need for them; every boot-time seam (session hooks, the skill gate, the tool
  filter) is instead bound over a `hostApiFor(extId)` LOOKUP so it can be wired
  before the Map is filled, since all three only fire at run time.
  **Failure posture, three tiers**: a bad `requires`, an unknown capability or an
  invalid/unsatisfied range is a BOOT failure (logged naming the extension,
  `process.exit(1)` — a manifest wanting a surface this server does not serve is
  a mistake, not a degradation to run around); a runtime throw from a façade
  method PROPAGATES (MCP error result, or the router's error envelope — no
  per-method try/catch); and the two advisory gates KEEP their asymmetry,
  `hideTool` failing OPEN and `skillsFor` suppressing nothing, because both
  narrow UX over an *advisory* identity and a bug must not leave sessions unable
  to act. Don't "fix" that for symmetry. **Versioning**: `HOST_API_VERSION`
  (`host-api/version.js`) is what the server serves and a breaking reshape adds
  `v2.js` keeping `v1.js` as the shim, selected by the declared range — never
  edit builders in place. `semver` is a real dependency, so
  `scripts/sync-deps.sh` means the SERVICE needs a restart for it to land
  (`node server/index.js` directly skips that). The client half mirrors the
  forced-value rule: `slots.apiFor` binds each extension's `send` to its OWN
  registered `handlerTypes` (carried on both the `extensions` connect message and
  `graph.extensions`) and FAILS CLOSED — an extension the board has heard nothing
  about may send nothing. **`onBeforeDispatch`
  is the only session hook that runs while the session exists nowhere** — after
  `dispatch` settles the card id, cwd and worktree, `await`ed, before the launch
  command is built — and that window is the whole point: state the agent's very
  first tool call depends on cannot be written by `onDispatch`, which fires
  after the entry is saved and therefore after the process is already running.
  **A manifest's `skills` list is all-or-nothing; `skillsFor` is the PER-LAUNCH
  narrowing, and it can only ever narrow its OWN manifest's list** —
  `createSkillGate` intersects the gate's answer with the `skills` it declared,
  so naming a sibling's skill (or `task-memory`, not an extension at all) does
  nothing, and a throwing gate suppresses nothing rather than stripping a real
  launch. It reaches the adapters as `disabledSkills`, threaded beside
  `taskMemory` through `buildLaunch`/`buildResume`/`buildFork` on BOTH adapters
  into `mandatorySkillPrompt`/`codexSkillCatalog` — a fourth launch path must
  thread it too. The `_extLaunchSkills` seam is consulted before the adapter
  builds and, in dispatch, deliberately AFTER `onBeforeDispatch`, so a gate can
  read back what that hook just persisted; `entry` is null at dispatch, the
  existing entry at resume and the PARENT's at fork (a fork's own entry is
  written after launch). **`hideTool` is the one surface that shapes tools an
  extension does NOT own, and it is a VETO that fails OPEN** — `buildMcpServer`
  filters `activeTools()` per request through `deps.ext.hideTool`, a throwing
  filter hides nothing and is logged, because this is a UX narrowing over an
  ADVISORY identity (`extractCaller` is not auth) and a bug must degrade to the
  full tool list, never to a session that can do nothing. `--allowedTools` is
  baked into launch argv and unaffected: granting a tool the listing does not
  advertise is inert.
  A graph contributor's keys are checked ONCE at boot against
  `RESERVED_GRAPH_KEYS` (`assertGraphKeys`, run in `index.js` against the real
  stores) because `rebuildOnce` is the ~4s tick where nothing may log or throw;
  a core graph key added to `rebuildOnce` must be added to that set or a
  contributor can silently overwrite it every tick. Session hooks
  (`_extHooks` on `SessionManager`, `_fireExtHooks`) are logged-not-thrown and
  sequential, never abort the core operation, and fire only on
  archive/fork/purge/dispatch/resume (never per tick, so `logError` there obeys
  the log rule); `onResume` fires in `_doResume`, not `resume()`, for the same
  coalescing reason the resume log line does. `/ext/<id>/*`
  (`http-handler.js`) validates the id by MEMBERSHIP in the loader's `dirs`,
  which holds the extensions that were enabled AT BOOT — one disabled at boot is
  a 404, never served, which is exactly why it cannot be turned back on live — and resolves the rest via `path.resolve` against the
  extension's `public/` with a prefix check, since `join(normalize())` folds a
  climbing `..` back inside instead of rejecting it. A new client slot needs a
  `SLOT_NAMES` entry in `slots.js` AND a host in `app.js` that mounts it;
  **`view` is the one slot with ONE host PER CONTRIBUTION, and `only` is what
  enforces that** — every other slot's host holds every contribution (a card's
  chip row shows all the pills), so `sync()` computes its keep-set per
  contribution: a host nobody addressed this round is not one to evict from, it
  is one that was never that contribution's. Its rail button, `.ext-view` host
  and `#view=ext:<extId>:<id>` route are all DERIVED by `app.js`'s
  `renderExtViews`, called from `syncClientExtensions` (a toggle, not a graph
  tick); `hashView` refuses an unregistered `ext:` key and `renderExtViews`
  re-reads the hash once a view registers, which is the only thing that makes a
  deep link survive the load race. **A manifest's `styles` is a `<link>` the
  loader adds BEFORE the module import and removes in `unload` and on a failed
  import** — rules that outlived their extension would style elements the core
  still draws — and an announcement carrying neither `client` nor `styles` is
  skipped rather than marked loaded, which would swallow the real entry on a
  later connect;
  mount-once is per HOST ELEMENT (a contribution's `c.mounts` is a host→element
  map), so a host rebuilt via innerHTML (`renderPanel`'s chips row) re-mounts
  each render while `#panel-sections` mounts once, and a throwing contribution
  is REMOVED from every host it occupies rather than allowed to blank the
  board. **A slot with one host per CARD is `syncHosts`, not
  `mountInto`/`update`, and the difference is load-bearing twice**:
  `card.pill`'s hosts are `.card-meta-ext` (cards.js `cardPillHostHtml`, on
  `.session-card` only — a `.worker-row` has no chip row to host anything), and
  `app.js`'s `mountCardPills` hands `syncHosts` `[{host, session}]` for EVERY
  card on screen, so each element is updated with its OWN card's session
  (`update` knows one session and would hand every card the selected one) and a
  card that has gone is torn down by OMISSION from that list — never by probing
  the DOM, since the caller has just rendered and `isConnected` would make the
  reconciliation untestable against an element stub. It hangs off
  `wireGridEvents`, the one function BOTH render paths (`renderGrid`,
  `renderFocusedTile`) already end with. **`BUILTIN` is EMPTY — this lands the
  API and its seams, with nothing migrated onto it yet** (asserted, so a stray
  manifest can't register tools and handlers on every install unnoticed), which
  is also why nothing here is exercised end-to-end by a real feature: the first
  manifest is the proof. **Migrating a flagged feature (checklist, task-memory,
  archive-review) is: manifest + `BUILTIN` row + delete its accessor,
  `set-<x>-enabled` handler and settings def** — never a fresh `if (id === …)`
  rung in `app.js`, since `setExtensionDefs` renders the Extensions tab off
  `graph.extensions`. A retired flag's stored value needs carrying over to
  `extensions.<id>` at that point; there is no migration table yet, because
  nothing has been retired.
