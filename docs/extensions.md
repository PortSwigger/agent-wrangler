# Extensions — invariants & footguns

The extensions API in one place: the manifest, the loader, installation and
provenance, the host-api façade, the client slots, and every footgun each of
those carries. Read this before changing anything under
`server/extensions/**`, `server/host-api/**`, `public/slots.js` or
`public/extensions*.js`.

- **An extension runs IN-PROCESS WITH FULL ACCESS TO THE MACHINE, and `requires` is
  DISCLOSURE, not enforcement.** The capability list says what a manifest asked the
  wrangler for; nothing stops its code — or any of its dependencies' — doing more,
  the browser half is trusted at exactly the same level as the server half (no
  iframe sandbox), and `npm ci --ignore-scripts` is a **mitigation, not a boundary**
  (it stops install-time lifecycle hooks only; dependency code runs in-process on
  first import). Installing one is as much trust as `npm install`-ing a package into
  the server. The audience is colleagues sharing internally; a public ecosystem is
  explicitly not designed for. **No copy anywhere in the product or the docs may
  imply sandboxing** — the consent modal's `TRUST_STATEMENT`
  (`public/extensions-panel.js`) is the canonical wording; don't soften it.
- **A bad manifest QUARANTINES, it does not fail boot — and this deliberately
  overrides the façade design's `process.exit(1)` tier.** `loadExtensions` stages an
  entry's whole contribution and commits none of it unless all of it validated, so a
  manifest colliding half-way through leaves no half-registered tool; a rejected one
  lands in `out.list` as `{ enabled: false, quarantine: '<reason>' }` and
  contributes nothing (no tools, handlers, stores, graph keys, hooks, sweeps or
  client asset). That posture exists because a manifest can now come from a git URL:
  one bad directory must not take the board down for every session. Three checks can
  only run outside the leaf — store construction, `buildHostApi`, the graph-key
  assertion — so `server/index.js` catches each per extension and calls
  `quarantineFor`, which deactivates (façade, stores, hooks, sweeps) and then
  `quarantineExtension`, which **unregisters by id** because the loader has already
  registered that manifest by then. `buildHostApi` still THROWS; only the catch
  moved. **Boot is no longer the only moment this happens**: a live ENABLE runs the
  same `activateExtension`, so the same three checks can quarantine a row minutes
  into a session — which is why `quarantineFor` deactivates first, where the boot
  version had nothing built yet to take back. Collision order is load-bearing: builtins come first, externals are
  appended, and every name check is first-come, so **a builtin wins every tie by
  construction and the EXTERNAL entry is the one quarantined**. Every bound session
  hook re-checks `hostApis.has(extId)` at CALL time — deactivation removes the hook
  from the list too, but the re-check is what makes it inert whichever of the two
  runs first, and a quarantine used to leave a live hook running with `host`
  undefined without it. A quarantined
  **builtin** additionally raises a persistent board banner with **no "dismiss for
  today"** (`graph.quarantinedBuiltins`) — a repo bug that silently contributed
  nothing reads as a feature that quietly vanished, which is the one way this is
  worse than the boot-fail it replaced; an installed one's reason stays on its own
  settings row. `system-banner.js`'s dismiss key is now **namespaced by producer**,
  because fd levels are descriptor counts (200/250/300) and heap's are percentages
  (50/75/90) on the same bare `level`, so dismissing an fd banner would have
  suppressed a 90%-heap one. One event log line per quarantine at boot, nothing
  per-tick.
- **`primeExtensions` ordering is the fragile part of installed-extension loading.**
  It is the one ASYNC door into the loader memo and the only one that includes
  externals (discovery must `await import()` each manifest); `getExtensions()` stays
  **synchronous and unchanged**, which is the whole reason the async work is a
  separate function — otherwise `client-config.js`/`agent-skills.js`/`tools/index.js`/
  `control/router.js`, and through them every agent adapter, would have to become
  async. The memo is filled once and never rechecked, so **anything reaching
  `getExtensions()` first silently pins a builtin-only board for the life of the
  process, with no error anywhere**; `primeExtensions` therefore throws if the memo
  is already set, and `server/index.js` awaits it at module top level, before the
  MCP registry, the control router's lazy handler map and any adapter import.
  `getExtensions()` deliberately does **not** also throw when called before priming:
  it cannot tell a mis-ordered boot from the adapters and the whole test suite
  legitimately calling it with an injected `{ builtin }` and no priming at all.
  **Filled once is not the same as fixed once**: `registerExtension`/
  `unregisterExtension` MUTATE that primed object in place afterwards, which is the
  whole live-registry mechanism — so the tripwire still means what it says (nothing
  calls `loadExtensions` a second time), and **nothing may ever reassign
  `loaded.list`**, which `index.js`'s `extBag` and every `ctx.ext` hold by
  reference (`unregisterExtension` splices for exactly this reason).
- **`server/extensions/install.js` is the ONE place that shells out to `git` or
  `npm`, and its URL allow-list is checked BEFORE git runs.** Same containment
  `pr-status.js` gives `gh` — nothing else in the tree may spawn either. Allowed:
  `https://`, `ssh://`, `git@host:path`. **`ext::` is refused because git's ext
  transport runs an ARBITRARY COMMAND** — a real RCE vector, and the URL is the one
  thing an installing human supplies; `file://` and bare local paths are refused
  because they sidestep provenance entirely (no remote to re-verify or update
  against). Whitespace and shell metacharacters are refused outright as defence in
  depth even though the URL never reaches a shell, so no future caller can
  reintroduce the hazard by interpolating a stored URL. The clone disables both
  protocols **in git itself** as well, because a clone can follow a submodule URL or
  a redirect nothing screened, and passes the URL after `--` as its own argv element
  (`execFile`, never `shell: true`). `package-lock.json` is **mandatory** and its
  absence refuses the install before the disclosure — an unpinned dependency set
  cannot be disclosed honestly, so there is nothing to consent to. The subprocess
  runners are a **module** seam, never an option on the incoming frame: a control
  frame is browser-supplied, so a `_clone` a client could set would be arbitrary
  code execution offered as an API.
- **An install's disclosure is read STATICALLY from the clone's `package.json`
  `wranglerExtension` block — the manifest module must NEVER be imported before
  consent.** `readDeclaration` (`extensions/install.js`) is that read. Two
  independent reasons and either alone forces it: importing `index.js` **executes
  third-party code**, which is the exact thing the consent modal exists to precede
  (a worse hole than the documented `--ignore-scripts` caveat, which at least only
  applies to an already-consented install); and `npm ci` runs only AFTER consent, so
  at disclosure time there is no `node_modules` and a manifest importing any
  dependency **cannot be imported at all** — with a lockfile mandatory, having
  dependencies is the expected case, so this made every non-trivial extension
  uninstallable (found live, against a real toy extension depending on `ms`). The
  block is duplicated between package.json and the manifest by design;
  `assertManifestMatchesDeclaration` closes the gap after `npm ci`, **failing the
  install** (nothing is on disk yet, so refusing is free) on a differing `id` or a
  `requires` wider than was disclosed. The provenance record's consented `requires`
  is therefore the **DISCLOSED** list, never the manifest's — that is what the human
  approved.
- **A disclosure awaiting consent is RECLAIMABLE after `PENDING_CONSENT_TTL_MS`
  (10 min), and the gate is `awaitingConsent`, never age alone.** The install lock is
  held across the human's decision because the staging dir is what a second install
  would collide with — but closing the modal, reloading the board or losing the
  socket all end a disclosure with nobody to answer it and the handler is told about
  none of them. Before this, one abandoned modal wedged **every** install on the
  instance until a restart, which is a real dead end and not the "a restart cancels
  nothing meaningful" the in-memory lock is justified by. Reclaiming is removing that
  staging dir and dropping the lock, and is deliberately silent (nobody wants that
  install any more). A clone or `npm ci` in flight must keep refusing however long it
  has taken — both are already bounded by their own `execFile` timeout — which is why
  age alone is the wrong test.
- **The external-manifest import scan is a CORRECTNESS rule, not a security one.**
  `FORBIDDEN_IMPORTS` (`extensions/external.js`, imported by `index.test.js` so the
  runtime scanner and the test cannot drift) is **trivially bypassed by
  `await import(...)`** and is not pretending otherwise. It exists because a static
  import of `session-manager` closes a real module cycle through `client-config.js`
  and the agent adapters and **breaks boot for the whole server** — far worse than
  one broken extension. It catches the honest mistake.
  **It scans the extension's OWN modules only, and its two exclusions are the same
  argument twice**: `node_modules` and anything matching `test`/`tests`/`__tests__`/
  `spec`/`__mocks__` or `*.test.js`/`*.spec.js` (`ownJsFiles`), because only a
  module the MANIFEST can reach closes the cycle — nothing imports a test file but
  a test runner. The server-entry pattern needs **two or more** `../` levels for
  the same reason: from a builtin the entry is `../../index.js`, while a single
  level can only be an extension's own manifest, since no relative path from
  `<DATA_DIR>/extensions/<id>/` reaches the repo at all. Both were false
  positives on the most obvious test an extension can ship — a manifest
  self-check writing `import ext from '../index.js'` — which quarantined the
  extension with a reason about server core modules it never imported. Matching
  by name costs nothing and claims nothing: a static import hidden in `x.test.js`
  is no more caught than the `await import()` the whole rule concedes.
- **Installed extensions live in `<DATA_DIR>/extensions/<id>/`; their provenance is
  `<DATA_DIR>/extensions.json`, deliberately NOT config.json.** config.json keeps the
  `extensions.<id>` enable flags and is untouched by this feature. A record is
  `{ id, originUrl, sha, installedAt, requires, dependencies }`, and the last two are
  the only reason it exists: `requires` is the **CONSENTED** set and `dependencies`
  the flattened lockfile list, and the installed tree is always whatever the new
  version ships — so without the record an update has nothing to diff against.
  DATA_DIR-relative on purpose: a `run-dev` instance starts with no installed
  extensions the same way it starts with no sessions, and `test-setup.js`'s
  `AW_DATA_DIR` redirect gives the tests that isolation for free. An extension with
  **no record** (a hand-dropped directory — a legitimate dev workflow) still loads,
  is not updatable, and is **not** capability-gated: placing it there by hand is its
  own consent. For an external extension the manifest `id` MUST equal its directory
  name, or the provenance record, the `/ext/<id>/` asset route and the uninstall path
  silently disagree about what is installed. Every computed path is resolved and
  asserted to stay directly under `<DATA_DIR>/extensions/` before any write or
  delete — the id comes from third-party data, and one missed check on a delete path
  is a wipe of an arbitrary directory.
- **An UPDATE *is* `ext-install` against the recorded `originUrl` — same clone, same
  consent modal, same handler — and RE-CONSENT is required only when `requires`
  WIDENS.** Unchanged or narrowed proceeds on the recorded consent, because nothing
  new is being asked for; a manifest that widens itself **in place on disk** after
  consent is caught at the next discovery and quarantined, which is why that check
  lives in `external.js` and not only at install time. The modal shows the **DIFF,
  not the full lists**: capabilities in full (at most 20, each one matters) but
  dependencies as the **direct** changes plus a count of the transitive remainder,
  since a real tree churns by hundreds of entries. Removals can only be filtered to
  "the package name left the tree entirely" — the record stores a flat list with no
  direct/transitive mark, and adding one would only help installs made from then on.
  "Check for updates" is one `git ls-remote` per installed extension, **on demand
  only** — no sweep, no background traffic to whatever host an extension came from,
  nothing logged — and a record-less extension is skipped.
- **One install at a time per instance, REFUSED not queued, behind an in-memory
  lock.** The staging dir (`<DATA_DIR>/extensions/.tmp/<tempId>/`) is the only
  durable artefact an interrupted install leaves, and boot sweeps it
  (`sweepStaging`, after the instance lock so a duplicate instance cannot sweep the
  running one's in-flight dir) — which is exactly what lets the lock be in-memory: a
  restart cancels nothing meaningful. The lock is held across the human's decision
  and released on every failure path, or one bad repository would wedge every later
  install for the life of the process.
- **Uninstall removes the directory and the provenance entry; whatever the extension
  wrote elsewhere survives because the wrangler does not know where it is** — a
  store's file is chosen by the extension's own factory, and there is no
  wrangler-owned per-extension data dir to sweep. An explicit purge is deferred, so
  the confirm copy (`uninstallBodyText`) states the gap rather than selling retention
  as a feature; it also only claims live code is still running when the extension is
  actually active (`enabled && !quarantine`) — a turned-off or quarantined one
  contributed nothing for a restart to clear.
- **Install goes LIVE; uninstall deregisters live but still says "restart to
  reclaim"; UPDATE keeps restart semantics on purpose.** `ext-consent`
  (`extensions-install.js`) re-runs boot's own admission checks against what it just
  wrote — `importViolation` BEFORE the import, `admitExternal` after it, both from
  `extensions/external.js` so an install can never admit something the next boot
  would quarantine — then registers the manifest and activates it, so the row, its
  tools, handlers, stores and client asset are all there before the reply lands. It
  rolls back COMPLETELY on any failure (registry, directory, provenance record), so
  a manifest whose store factory throws leaves the board as it was. Two exceptions,
  both because **Node cannot unload a module**: an id that already carries a row
  (an update, a reinstall over a live one, a fix-by-reinstall of a QUARANTINED one)
  takes the old restart path, since activating the new version would run two
  versions of one extension at once; and uninstall deactivates and deregisters
  immediately but still asks for a restart, because the old module — and anything
  its top-level code started, a timer of its own or a global listener — is resident
  until then. That is the whole of the "restart to reclaim" caveat, and
  `deactivateExtension` cannot touch it. The import is cache-busted (`?t=`), or a
  same-id reinstall in one process gets the version that was just deleted from disk;
  an installed extension's `/ext/<id>/` asset URLs carry its pinned commit as `?v=`
  for the browser-side half of the same problem (the ESM cache is per URL, and the
  announcement is re-sent on every registry change). **Config, not the install
  button, decides whether it RUNS** — an extension whose `defaultEnabled` is false,
  or whose `extensions.<id>` is a stale `false`, lands registered-but-inactive and
  the reply says `active: false`, because an install must never leave the process in
  a state a restart would not reproduce.
- **"Restart the wrangler to finish" now comes with the button that does it — ONE
  button, in the panel head beside "Check for updates" (a restart is a
  whole-wrangler action, so several pending rows must not each draw their own), in
  the amber `--warn`/`--warn-fg` role rather than Uninstall's danger red; the rows
  and the install form still say what is waiting on it. The button exists ONLY
  under a supervisor.** `AW_SUPERVISED=1` is exported by
  `scripts/wrangler-start.sh` — which is what both the launchd plist and the systemd
  unit exec, and both bring the process straight back — so the flag means "something
  will restart me", never "I am on macOS"; under `npm start` or bare `node
  server/index.js` an exit is a shutdown with nothing to return the board, so
  `restart-server` refuses and the client (`config.canRestart`) never draws the
  button. The handler (`control/handlers/restart.js`) acks BEFORE the exit is armed
  (the socket dies with the process) and the exit itself lives in `index.js`'s
  `ctx.restart`, which calls `shutdownLog.noteReason` first — a self-inflicted exit
  with no reason logs exactly like the hard kill an absent reason is supposed to
  mean. The board's own pending notes (an uninstalled row, a finished install) are
  cleared by the next `config` frame, which is the first frame of every reconnect
  and therefore the only reliable "the restart happened" signal a client gets.
- **The Extensions tab is ONE list, and every row is a `.setting-row` carrying
  `data-id="ext:<id>"`.** Builtin and installed extensions used to render through two
  paths — `settings.js`'s `rowHtml` toggles above, the panel's installed rows below —
  which printed the same name and description twice. `setExtensionDefs` therefore
  registers its defs in `byId` but leaves the tab's `settingIds` **empty**: the defs
  still exist so settings.js's delegated flip handler and `getSetting` work, while
  `extensions-panel.js` draws the rows (toggle included, via the same markup
  `rowHtml` emits) so third-party strings stay on the `textContent` path. Putting an
  id back into `settingIds` renders that extension twice.
- **A row shows name, description and origin only — no commit, author or local
  path** (they were unactionable there); the commit and author stay on the consent
  modal, which is where "which code exactly, and whose" is the decision. **Update is
  drawn only when a check actually found a newer commit** (`status.behind`), so the
  button never implies an update that does not exist, and the check itself reports
  `Checking…` on the button and each row. Settled reports — `Up to date.`,
  `Cancelled. Nothing was installed.`, a finished install — are cleared after `EXT_TRANSIENT_MS`
  (`TRANSIENT_PROGRESS_PHASES`, `public/app.js`): they describe a moment, not a
  state. Anything still awaiting action (a newer commit, an unreachable origin, a
  pending restart) is deliberately NOT on that timer.
- **Every third-party extension string goes into the DOM via `textContent`.** Label,
  description, author, homepage, capability and dependency names, quarantine reasons
  — same rule as `diff-dom.js`/`checklist-dom.js`, which is why
  `public/extensions-panel.js` exists as its own module rather than more
  `settings.js` rows (those are `innerHTML` + `esc()`, and this content came off a
  git URL a colleague pasted). `homepage` is a link **only** when it is `https://`,
  otherwise plain text: a third-party href is not worth the navigation surface for a
  decoration. The consent modal has **no Enter-to-approve**, unlike `confirmDialog`,
  because approving grants a process full access to the machine.
- **A manifest's `settings` are DEFS; their values live in
  `extensionSettings.<id>.<key>`, a block of their own and NOT inside
  `extensions.<id>`.** That key is the enable flag and is a BOOLEAN, so keeping the
  two apart is what makes it impossible for a manifest declaring a setting called
  `enabled` — or for a hand-edit — to make the toggle and a value the same key;
  values are config, so they survive an uninstall/reinstall, which an extension's
  own store does not. A def may DECLARE CONSTRAINTS — `min`/`max`/`step` on a
  number, `maxLength`/`pattern` on text, `options` on the `select` type — and
  both halves of that live in `server/extensions/setting-constraints.js`
  (`validateSettingDef` for a def, `checkSettingValue` for a value) so a
  constraint nobody enforces cannot be declared and an enforced one cannot go
  unvalidated. It is a LEAF, which is why `MAX_TEXT_LENGTH` moved there and
  `ext-setting-set.js` RE-EXPORTS it rather than the other way round. A field on
  the wrong type is a def error, never ignored; a `pattern` is anchored
  `^(?:…)$` so it means what HTML's implicitly-anchored `pattern` means, and is
  length-capped only to bound a careless regex — nothing here is a sandbox. The
  write path REJECTS and never clamps (a clamp is the same lie as a coercion),
  CLEARING (`null`, `''`) skips every constraint, and the READ path is
  untouched, so an out-of-range value already in config.json still reaches the
  extension and an extension keeps its own guard. The panel mirrors the fields
  onto native inputs and gates `send()` on `checkValidity()` — an AFFORDANCE,
  and deliberately not a second copy of the rule engine in the browser; a
  rejection must not move `last`, or the corrected value looks unchanged and the
  fix is swallowed. The vocabulary widening is what makes it a MINOR
  (`HOST_API_VERSION` 1.5.0): an older server QUARANTINES a manifest declaring
  `select` or a `min`, and the declared range is the only thing that can say so.
  There is no `default` on a def (an unset setting reads
  `undefined` and the extension supplies its own fallback, which is also what lets
  one be deliberately inert until configured) and no `secret` type (a masked input
  round-tripping through config.json in plaintext would imply a protection that
  does not exist). Keys are namespaced by extension id, so they claim nothing in
  `_reg` and stage nothing — the only contribution on a list entry that does
  neither, which is why `unregisterExtension` has nothing to take back. They are
  COPIED onto the entry and copied again by `extensionsForGraph`, so a manifest
  mutating its own array cannot move what the panel draws or what
  `ext-setting-set` validates against. **`host.settings` is UNGATED for the same
  reason `stores` is** — the extension's own data, not a core surface — narrowed
  by the CLOSED-OVER id exactly like `broadcast`'s `type` and `mail.send`'s
  `from`, so no signature reaches a sibling's block, and READ-THROUGH on every
  call because the façade is built once per activation and an edit must land
  without a restart; an undeclared key reads `undefined` from both `get` and
  `all`. It is an addition to `alwaysPresent` and NOT a capability, so
  `CAPABILITIES`/`V1_BUILDERS` are untouched and the bump is a MINOR
  (`HOST_API_VERSION` 1.1.0). **`ext-setting-set` is CORE-owned and untagged**: an
  extension whose own handler could write `extensionSettings.<its id>` would be
  authoring the record of what a human chose. It validates a browser-supplied
  frame against the DECLARING MANIFEST'S OWN defs — the def's type decides how
  `value` is read, a misfit is an error envelope rather than a coercion — refuses
  a quarantined extension whatever the panel did, and ends with `ctx.rebuild()`
  and deliberately NOT `ctx.ext.changed()`, since nothing about the registry
  moved. On the client the rows are **NOT in the Extensions tab**: the tab is a
  list of the extensions you have, and every manifest's fields laid out flat
  under it buried that, so a row draws a **cog** (only when it declares
  settings, making the cog's presence the disclosure that there is anything to
  configure) and `app.js`'s `openExtSettings` puts that one extension's rows in
  their own dialog, built fresh per open from `latestExtensions` — never from
  the entry the row was drawn with, which may be several graphs old by the time
  the cog is clicked. A QUARANTINED extension keeps its cog and gets its rows
  DISABLED, which says "this is what it would want" where a hidden cog would
  make a broken extension look like one with nothing to configure; merely being
  switched off disables nothing (a value persists, and setting a URL before
  switching the thing on is the natural order). The rows carry
  `data-ext`/`data-key` and **no `data-id`**: `settings.js`'s delegated handler
  picks up any `.setting-toggle` in the modal and looks the row up with
  `byId.get(row.dataset.id)`, so putting `ext:<id>` on one of these rows would
  make a toggle-type SETTING flip the EXTENSION's enable flag — which is also
  why a toggle row moves its OWN switch on click (nothing else is coming to
  redraw it, and an input keeps its text only because the browser holds it).
  `app.js`'s remount signature **excludes `settingValues`**, which now costs
  nothing at all: the tab draws no value, so a value landing is not news for it
  to redraw for, and the dialog re-reads on every open.
- **An extension may SHIP a skill, and the whole catalog is assembled in ONE
  place: `agent-skills.js`'s `allSkillEntries`.** A manifest's `skills` names
  either one of the wrangler's own `agent-skills/skills/<name>` (all it could
  name before this, and still how it GATES one) or its own
  `<dir>/skills/<name>/SKILL.md` — same layout, sidecar `WRANGLER.md` included.
  The merge reads the loader's list rows (`id`/`dir`/`skills`) on EVERY call, so
  an install adds a skill and an uninstall takes it away at the next launch with
  nothing to invalidate; a row is the registration, not the directory on disk.
  Names are one flat namespace keyed by the frontmatter `name`: the in-repo
  skill wins any clash, and a SHIPPED name is claimed in `_reg.skillNames`
  exactly as a tool name is (so the second extension to ship one is quarantined,
  and a disable releases it), while an in-repo name claims nothing — several
  manifests gating `checklist` is ordinary. A declared name resolving to NEITHER
  place is a quarantine, because it used to be silently inert: the manifest said
  it contributed a skill and the catalog had never heard of the directory.
  **The reader lives in `server/skill-catalog.js`, not in `agent-skills.js`,
  purely because the LOADER needs it too** and `agent-skills.js` already imports
  the loader for `getExtensions()` — it is a leaf (fs/path/url), so
  `server/extensions/**` may import it without breaching its own rule.
  **Claude's plugin list is the one channel the gate reaches**: an extension's
  skill is outside `AGENT_SKILLS_PLUGIN_DIR`, so each ACTIVE one rides as a
  `--plugin-dir` of its own (a directory holding a SKILL.md loads as a one-skill
  plugin, the `ISSUE_TO_PR_SKILL_DIR` shape), and unlike the in-repo root that
  list is filtered — most extension skills carry no nudge, so discovery is their
  only channel and leaving a suppressed one on the command line would make
  `skillsFor` decide nothing for Claude. The devcontainer runtime copies every
  installed extension's skill dirs in UNGATED (`launchInputs`), a superset: the
  gate has already answered by the time the inner command exists, and a dir
  copied but never named costs kilobytes where one named but not copied is a
  plugin path the container does not have. `external.js`'s import scanner skips
  the ROOT `skills/` directory for the same reason it skips tests — a script a
  skill ships for its agent is unreachable from the server's import graph.
- **Extensions API (`server/extensions/index.js`, `public/slots.js`,
  `public/extensions.js`) — an optional feature is ONE manifest, and the loaded
  object is a LIVE REGISTRY, not a boot snapshot.** A manifest
  (`server/extensions/<id>/index.js`, exporting `dir` from `import.meta.url` and a
  default `{id, label, help, defaultEnabled, stores, handlers, tools, skills,
  skillsFor, hideTool, graph, session, sweeps, client, styles}`) is validated at boot (`validateManifest`,
  every throw names the id) and `index.js` exits 1 on a bad one — a manifest
  colliding with a core tool name or handler type is a config error a human must
  see, not something to limp past. Enabled is `extensions.<id>` in config.json
  (`extensionEnabled`, `config-store.js`), and **a toggle now moves at ONE time,
  not two**: `extension-enabled.js` writes the config, then re-stages the manifest
  and calls `ctx.ext.activate` (on) or deactivates and deregisters (off), so tools,
  handlers, stores, sweeps and the client asset move with the UI.
  `graph.extensions[].enabled` is still re-read from config on every rebuild
  (`extensionsForGraph`), and `bootEnabled` beside it **keeps its name but now means
  "ACTIVE in this process right now"** — the two differ only inside the window
  between a flip and its activation settling, and for a quarantined row. **The ONE
  remaining lag is MCP tools inside an ALREADY-RUNNING agent**, whose
  `--allowedTools` is baked into its launch argv, so it gains or loses them at its
  next resume. An extension that booted OFF *can* be turned on live: the loader
  keeps every manifest it read in `_manifests`, disabled ones included, and that map
  is the only thing a re-stage can work from. The enable path releases the id
  (`unregister`) BEFORE staging — the loader claims one in `_reg` for every entry it
  reads, so staging would otherwise fail as a duplicate of the row it is replacing.
  **Timing is told to a human by `extensionFlipNote` (`public/settings.js`) AFTER a
  flip, never by the manifest's `help`** — two lines now, neither naming a restart,
  both naming the next-resume lag, because "the panel went and my agent still has
  the tools" is otherwise indistinguishable from a switch that did nothing. A static
  help sentence cannot say this: a blanket "takes effect after the wrangler
  restarts" was once appended to any help that didn't mention one, and it is simply
  false. A manifest's `help` says what the feature IS and what survives a toggle,
  nothing about when.
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
  **That map is the ONE place in the server that caches the registry rather than
  reading it per call, so every live change must end with `ctx.ext.changed()`** —
  which calls `invalidateHandlerMap()` (`control/router.js`), re-derives the
  `hideTool` veto, and re-broadcasts the `extensions` client manifest so a new
  extension's `client`/`styles` load without a reload. Miss it and a handler
  registered in-process is never found, for the life of the process.
  **Sweeps go through `startSweepsFor` (`index.js`), and at BOOT they are deferred
  to `main()`, after the instance lock** — a duplicate instance must not sweep a
  `DATA_DIR` it is about to be refused, the same reason `sweepStaging` waits —
  while a live activation is always post-lock and starts them at once.
  `sweepHandles` is what lets a deactivate stop them; a session hook's wrapper
  carries an `.extId` tag for the same reason, since that is what a deactivate
  filters one extension's hooks out on.
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
  capabilities** — a deliberately minimal `{id, extId, settings, log}` bag —
  because factories run before `rebuild`/`broadcast`/`deliver` exist at all and a
  constructor has no need for them; **`settings` is the ONE exception, and config
  is why it can be**: it is a synchronous read of config.json, which nothing has
  to bind, so it is available at the one moment a façade is not — and without it
  a store could not be CONFIGURED at all, which is what forced every extension to
  hard-code its own state-file path. It is `buildExtSettings`
  (`host-api/index.js`, exported for this and used by `host.settings` itself, so
  the narrowing, the read-through and the declared vocabulary cannot drift between
  the two callers). `id` stays the **STORE NAME** — a store logs and names itself
  by it, and renaming it would break every store already reading it — so the
  extension's own id rides alongside as `extId`, which is what a factory placing
  a file under a per-extension path needs. The bag is not a façade key, but a
  manifest can only declare a dependency on the number, so it is still a MINOR
  (`HOST_API_VERSION` 1.3.0); every boot-time seam (session hooks, the skill gate, the tool
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
  about may send nothing. **The INBOUND half is `onMessage`/`dispatchMessage`
  (`HOST_API_VERSION` 1.2.0), and the address is the FORCED type, nothing in the
  payload**: `host.broadcast` stamps `ext:<id>` from the closed-over id, `app.js`'s
  ws ladder hands every `ext:`-prefixed frame to `slots.dispatchMessage`, and it
  calls only the listeners THAT id's own module subscribed — so an extension can
  neither hear a sibling's frames nor one aimed at a core type. Before it the
  frame fell off the end of that `else if` ladder and was silently dropped, which
  is why a server half had no way to tell its own browser half anything. The
  version bump is the point of the change being declarable at all: there is no
  new server-side key, so `engines.wranglerApi: '^1.2.0'` is the ONLY thing that
  stops a manifest whose client calls `onMessage` booting against a server whose
  `app.js` would drop its frames. `onMessage` is on BOTH the api and the
  registrar `forExtension` returns, and the registrar is the normal place: the api
  reaches a module through `mount`, and `card.pill` has one host PER CARD, so
  subscribing there subscribes once per card on screen — which is what the
  returned unsubscribe is for. A throwing listener is reported and **KEPT**,
  deliberately unlike a throwing contribution: mount/update run inside the
  board's own render and removal is what protects that render, while a listener
  can hurt nothing but itself and deafening an extension for the life of the page
  over one bad frame is the worse failure. An unknown or unloaded id dispatches
  nowhere and is NOT reported (an extension with no client half is ordinary, and a
  broadcast per tick would print a line per tick); a malformed type IS, since only
  a core bug makes one. `removeExtension` drops the listeners with the apis, so a
  disabled or uninstalled extension stops hearing at the same moment it stops
  drawing. **`onBeforeDispatch`
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
  into `mandatorySkillPrompt`/`codexSkillCatalog`/`extensionSkillPluginDirs` — a
  fourth launch path must thread it too. The `_extLaunchSkills` seam is consulted before the adapter
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
  A graph contributor's keys are checked ONCE PER ACTIVATION against
  `RESERVED_GRAPH_KEYS` (`assertGraphKeys`, run by `activateExtension` in
  `index.js` against the real stores) because `rebuildOnce` is the ~4s tick where nothing may log or throw;
  a core graph key added to `rebuildOnce` must be added to that set or a
  contributor can silently overwrite it every tick. Session hooks
  (`_extHooks` on `SessionManager`, `_fireExtHooks`) are logged-not-thrown and
  sequential, never abort the core operation, and fire only on
  archive/fork/purge/dispatch/resume (never per tick, so `logError` there obeys
  the log rule); `onResume` fires in `_doResume`, not `resume()`, for the same
  coalescing reason the resume log line does. `/ext/<id>/*`
  (`http-handler.js`) validates the id by MEMBERSHIP in the loader's `dirs`,
  which register/unregister maintain, so it holds the CURRENTLY ACTIVE extensions —
  a disabled or uninstalled one is a 404 from the moment it is deregistered — and resolves the rest via `path.resolve` against the
  extension's `public/` with a prefix check, since `join(normalize())` folds a
  climbing `..` back inside instead of rejecting it. A new client slot needs a
  `SLOT_NAMES` entry in `slots.js` AND a host in `app.js` that mounts it —
  `dispatch.field` needs THREE (one per anchor) and its entries carry `at`;
  **`view` is the one slot with ONE host PER CONTRIBUTION, and `only` is what
  enforces that** — every other slot's host holds every contribution (a card's
  chip row shows all the pills), so `sync()` computes its keep-set per
  contribution: a host nobody addressed this round is not one to evict from, it
  is one that was never that contribution's. **`at` is the second, INDEPENDENT
  entry filter on that same line, and the GROUP-shaped version of the same
  argument**: `only` names one contribution's own host, `at` names a group of
  contributions' shared anchor — same conclusion, so they stay two filters and
  folding one into the other would lose the group case. Its rail button, `.ext-view` host
  and `#view=ext:<extId>:<id>` route are all DERIVED by `app.js`'s
  `renderExtViews`, called from `syncClientExtensions` (a toggle, not a graph
  tick); `hashView` refuses an unregistered `ext:` key and `renderExtViews`
  re-reads the hash once a view registers, which is the only thing that makes a
  deep link survive the load race. **The `syncHosts` call is split out as
  `updateExtViews` and runs on EVERY graph as well** — a view is the one slot
  with no render path of its own (the panel slots go through `renderPanel`, the
  card pills through `wireGridEvents`), so its host was created once and nothing
  came back to it, leaving `update(el, session, graph)` effectively dead and a
  whole pane stale until a reload; `syncHosts` was already being handed
  `latestGraph`, which is what makes that an oversight rather than a design.
  Only that call may go on the tick, never `renderExtViews` itself: it creates
  and destroys rail buttons and re-reads the hash for the deep link above. **A manifest's `styles` is a `<link>` the
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
- **`dispatch.field` is the first slot that shapes a CORE form.** Three anchor
  hosts (`top`/`model`/`advanced`) inside `#m-dispatch-fields`, and `at` is
  REQUIRED at register — unlike a panel chip a form has no sensible default
  place, and a control landing in the wrong block is worse than one that fails
  to register, so a bad `at` THROWS at load like every other register-time
  refusal. Entries carry `at` alongside `only`, so one anchor host holds EVERY
  contribution addressed to it and a contribution is never torn out of a host
  that was never its. The `model` host sits **outside** `#m-model-row` on
  purpose: an extension that hides the core model row must not hide its own
  replacement with it, and getting that wrong is silent, so
  `dispatch-modal.test.js` asserts the ordering. It is the one slot with **NO
  graph-tick path** — its hosts exist only while the modal is open and a human
  is driving it — so `syncDispatchExtFields` hangs off `openModal`, the
  `#m-model` change listener, `syncWorkflow` and `syncClientExtensions`, and in
  `subagent` modalMode it is called with an **EMPTY host list** so contributions
  tear down by omission rather than sitting invisible inside a hidden block.
  **The veto is TWO keys and fails CLOSED on authority, OPEN on health.** The
  manifest's `hideDispatchField` is the DISCLOSURE — a static array (never a
  function: the board must know what an extension may suppress before any of its
  code runs), validated against the server-side `DISPATCH_FIELDS` set, riding on
  the `extensions` announcement and `graph.extensions` exactly as `handlerTypes`
  does. A contribution's `hides` is the per-contribution USE, filtered against
  it, and an undeclared name is DROPPED and reported: the browser half may never
  widen what the server half disclosed, the same rule as `send`. The veto holds
  only while that extension has a LIVE contribution, so the existing "a throwing
  contribution is removed" rule brings the core row back on its own — which is
  also why a throwing `fields()` DROPS the contribution rather than being
  reported-and-kept like an `onMessage` listener: keeping it would leave a
  broken extension holding its veto while contributing nothing. Hiding is
  **PRESENTATION ONLY** — the core control keeps its value and
  `readCoreDispatchFields` still reads it, so an extension that hides a field
  and does not write the key back gets whatever the hidden control held; that is
  the single most likely misunderstanding of the feature. **The payload merge
  lives in the ONE shared read**, which is why scheduled dispatch and the ⌘1–⌘3
  quick-launch path get it for free, and why `readDispatchFields` had to SPLIT
  into a core half (`readCoreDispatchFields` — what the ctx's `draft` is, and
  what the merge spreads over) and the merged whole: miss the split and building
  a ctx re-enters every `fields()`, which builds a ctx, which… `undefined`
  values are dropped (a contribution saying "no opinion" must not blank a core
  field) while `null` is kept, and a second writer of the same key logs a
  collision and wins. **ANY core key is writable by design**, `cwd` included —
  guarding it here would be theatre when an extension already runs in-process
  with full access to the machine and its server half could `sessions:spawn`
  anything it liked. **`HOST_API_VERSION` 1.6.0**, a vocabulary widening with no
  new façade key, and the argument runs from both halves at once: an older
  `slots.js` THROWS on an unknown slot name (so the whole client module fails to
  load) and an older server quarantines an unknown `hideDispatchField`, so the
  declared range is the only thing that can say which servers a manifest will
  load on. `DISPATCH_FIELDS` is deliberately FOUR names — each is a commitment
  that `app.js` has a row id in `DISPATCH_FIELD_ROWS` and `index.html` a
  `.dispatch-field` wrapper, so widening it is a MINOR plus three edits.
  **`BUILTIN` stays empty** and its assertion stays: this is API only, and the
  coverage is test fixtures.
- **`card.action` and `card.cost` are VALUE slots — no host, no mount — because
  the chrome they feed is core markup an extension can never mount into.**
  `register` requires `items`/`cost` in place of `mount`. `slots.menuItems(s,
  graph)` is appended to BOTH the card right-click menu and the pane's Actions
  menu (`app.js extMenuItems`, with the auto-fix/auto-merge settings group);
  `label` and `hint` are TEXT and are escaped (`hint` fills the trailing slot),
  `icon` is markup exactly as a `view`'s is, and `run` is wrapped so a throw is
  reported rather than escaping into the menu's click handler.
  `slots.costCeiling(s, graph)` returns **NUMBERS ONLY** — `{ usd, reached }` —
  and `cards.js costTagHtml` draws the ` / $50.00` and the red
  `cost-limit-reached` tone itself, so no extension string reaches the tag; the
  first answering contribution wins and a second is reported once per pair (it
  runs per card per render, so never per call). A throwing `items()`/`cost()`
  removes the contribution, the same rule as `badge`.
- **`task.action` is `card.action` for a TILE, and its subject is `{ id, name,
  adhoc }`, never the DOM cell.** `slots.taskMenuItems(task, graph, api)` shares
  `menuItems`'s whole body (`valueMenuItems`), so the item shape, escaping and
  guards cannot drift between the two. It feeds ONLY the tile's right-click menu
  (`app.js openTaskMenu`, between the task's own actions and Archive task) — NOT
  the header kebab (`openTaskActionsMenu`), which already carries core's
  Minimise/Focus and would show an extension's duplicate beside it. The no-task
  tile is included, as `adhoc: true` with the reserved `ADHOC_ID`, because it
  can be minimised too. **`api.minimiseTask(taskId)`** (1.11.0) is the action it
  exists for: base-api-only for `openSession`'s reason (the minimised set is
  `app.js` view state, not a frame `send` could carry), and it returns a boolean
  because `minimise()` silently refuses the last visible tile — an extension
  must be able to tell. `app.js` also refuses an id not in `currentOrder()`, or
  an archived task would sit in the minimised set until the next prune.
- **A `dispatch.field` contribution's `ext(el)` is data for its OWN server
  half, and the namespace is FORCED.** `dispatchFields` puts it at
  `payload.ext[<extId>]` (a `fields()` writing `ext` whole is refused and
  reported, or it could overwrite a sibling's slice); `runDispatch` →
  `sessionManager.dispatch` → the `onBeforeDispatch` payload carries the whole
  bag, and `hookPayloadFor` (extensions/index.js, applied by `index.js`'s hook
  binding) narrows it to that extension's slice — `null` when it sent nothing.
  A scheduled dispatch stores the payload whole, so the bag fires with it.
- **`host.sessions.spawn({ taskId })` binds task memory BEFORE the pane starts,
  and `tasks.assign` after the spawn is NOT the same thing.** The option becomes
  dispatch's `bindMemory`, which points the session's `by-session` symlink at
  the task folder in the window before launch; assigning afterwards repoints the
  same link, which a running **Claude** follows and a running **Codex** does
  not — Codex resolves its writable roots once, at launch, so a late repoint
  leaves it writing into the session's own scratch memory while the board says
  it is on the task. The builder therefore does BOTH halves (bind pre-launch,
  `taskStore.assign` after), exactly as the `spawn_*` tools and the board's own
  dispatch handler do; that assign is not a `tasks:write` escalation, because
  the only card it can name is the one the call just minted. The same "ask the
  wrangler, don't reimplement it" rule is why `worktree: {branch, base, auto,
  folderName}` exists: an extension that cuts its own worktree and launches into
  it as a plain cwd gets no worktree record on the card, and the badge, the
  archive-time cleanup offer and core's `name_branch` all key off that record.
  Unlike the rest of v1 — thin binds that let the primitive validate — every
  spawn option is type-checked in the builder and refused BY NAME, unknown keys
  inside `worktree` included: dispatch is forgiving, so a mistyped option
  silently launches something subtly different (no grants, no worktree, the
  wrong base commit) and the extension author has no stack into core to read.
