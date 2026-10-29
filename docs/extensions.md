# Extensions

Extensions can add tools, handlers, board state, settings, hooks, skills, scheduled work, actions,
dispatch fields, views, and browser UI.

Extensions run with the server's machine access. Capabilities are disclosure, not a sandbox; install
only trusted code and dependencies.

## Install and manage an extension

Open **Settings → Extensions**, choose **+ Add extension**, switch to **Git URL**, paste a git URL, and review the identity, dependencies, and
capabilities. `https://`, `ssh://`, and `git@host:path` remotes are accepted; local paths, `file://`,
and `ext::` are refused.

Git runs without a prompt, so a private GitHub repository needs a credential helper. Run
`gh auth login`, then `gh auth setup-git`, and install from its `https://` URL. When a clone or
update check fails that way, the Extensions tab says so.

The tab is a list beside a detail pane, and opens on the **+ Add extension** pane. The list groups **Core** extensions (they ship with the
wrangler) and **Installed** ones (from git URLs), each with a dot that is filled when it is enabled;
**Filter** narrows it by name. **Check all** in the Installed heading checks every installed extension
for a newer commit; when one is found, **Update all** appears beside it and the extension gets its own
update button in the list. With Settings › Updates on Notify or Auto, the hourly update check also
checks installed extensions: an outdated one shows its update button and how many changes it is
missing without pressing Check all, the Extensions tab and the Settings button are badged, and a
toast says so once per new commit. Extensions are not updated automatically, even on Auto, unless you
turn on **Auto-update** for that extension (see below).
Updated code loads only when the wrangler restarts. Where the wrangler can restart itself, the update's
consent dialog offers **Update & restart** (**Approve, update & restart** when the update asks for new
capabilities), which restarts once the update has installed; after **Update all**, it restarts once,
after the last update. **Update without restarting** applies the update and leaves **Restart now** in
the panel for later. Elsewhere the dialog offers just **Update**.
Select an extension to see its **Enabled** switch, **Uninstall…** (installed
only), its **Auto-update** switch (installed from a git URL only), its **Source** (type, repository and
commit) and its **Settings**.

### Auto-update an extension

**Auto-update** is off for every extension until you turn it on in that extension's detail pane, and
there is no switch for all of them. Turning it on asks you to confirm first, because from then on new
commits pushed to its repository, by its owner or by anyone who gains control of it, are installed and
run with the extension's capabilities without you reviewing the code. Core extensions and extensions
placed in the extensions folder by hand have no Auto-update switch.

An extension with Auto-update on is updated by the hourly update check, so only while Settings ›
Updates is on Notify or Auto. An update is applied only when it asks for no new capabilities and passes
the same lockfile and host API checks as an update you start yourself. Otherwise it stays an update
button for you to review, and its detail pane says why it was not applied. The updated code loads at
a restart. Where the wrangler can restart itself (it runs as a background service), it restarts on its
own once it is idle: no headless runs or session launches in flight and no scheduled session due in the
next two minutes. While it is busy it looks again every minute, and several updates, or an update of
Agent Wrangler itself in the same check, share one restart. Where it cannot restart itself, the
updated code loads the next time you restart it.

### Early-adopter builds

An extension can publish early builds on a branch of its own repository and declare it as
`earlyAdopter: { branch }` (see below). Agent Wrangler draws no switch for it: the extension offers
its own way to opt in. While an install is opted in, reinstalling it, checking it for updates and
updating it all follow that branch instead of the repository's default branch, and fall back to the
default branch while the remote has no such branch. Opting out takes effect at the next update,
which returns to the default branch. Updates from the branch still go through the same review,
lockfile and host API checks, and through Auto-update only if that is on as well.

**+ Add extension** opens on **Browse GitHub**, which lists public GitHub repositories tagged with the
[`agent-wrangler-extension`](https://github.com/topics/agent-wrangler-extension) topic, as cards with
the owner's avatar, description, stars, language and last update. **Install…** on a card goes through
the same review as a pasted URL; repositories you already have are marked **Installed**. The list is
searched the first time the tab opens and on **Refresh**; the search box above the cards narrows that list by
name, owner or description without asking GitHub again. Anyone can tag a repository, so a listing is not a
review or an endorsement; check the code and its author before installing.

The panel also enables, configures, updates, and uninstalls extensions. New installs become live when
possible; updating loaded code or fully unloading it requires a restart.

An install or update whose `engines.wranglerApi` range this Agent Wrangler's host API version does not
satisfy is refused before anything changes: the clone is discarded, nothing is offered for consent, and
the panel says why, for example "requires a newer Agent Wrangler (needs host API ^2.0.0, this is
1.31.0)". For an update, that line replaces the extension's update button until the next check and the
installed version keeps running. Update Agent Wrangler, or wait for a compatible release of the
extension.

## Core extensions

Some extensions ship inside Agent Wrangler itself. They are listed under **Core** in the same
tab, can be turned on, turned off or configured like any other, but they have no origin to
update from and cannot be uninstalled.

| Extension | What it adds | Settings |
| --- | --- | --- |
| **Per-session checklist** | The session checklist panel and chip, its four MCP tools and the `checklist` skill. See [Board and sessions](board-and-sessions.md). | None. |
| **TODOs** | Board TODOs for each task and the Unassigned tile, their MCP tools and the `archive-to-todo` skill. See [Board and sessions](board-and-sessions.md#organise-work-with-tasks). | None. |
| **Jira** | The `jira` link type and its board chip: agents attach a Jira issue to a session or task with `set_links`, and the chip links to the issue. See [Board and sessions](board-and-sessions.md#organise-work-with-tasks). Off, stored Jira links are kept (and survive `set_links`) but draw no chip and no new ones can be set. | **Jira base URL**: what a bare issue key is appended to, e.g. `https://yourcompany.atlassian.net/browse/`. Empty uses `AW_JIRA_BASE_URL` if set; a bare key otherwise renders without a link. The old `jiraBaseUrl` config value, or `AW_JIRA_BASE_URL`, is copied into it at boot. |
| **Sounds** | Browser audio cues when sessions finish or need attention. Focus mode silences other tasks. | Extension enablement controls playback. Audio-file uploads for each cue (up to 1 MB each), preview and reset to built-in tones are shared across browsers. |
| **Themes** | The Cyberpunk, Dolphin, Pink, Pixel Cats and Wrangler themes in Settings › Appearance. On by default. Off, a browser that had one of them chosen shows Dark until it is back on. | One switch per theme, drawn as the theme picker's buttons: a highlighted theme is offered in the picker, and clicking it turns it off or on. Every theme is on until switched off. |
| **Adversarial PR review** | The `adversarial-pr-review` skill and its reviewer's `adversarial_review_process` tool. See [Reviews and pull requests](reviews-and-prs.md#ask-for-an-adversarial-pr-review). | **Review process**: what the reviewer checks and how. Empty uses the built-in process; anything written replaces it. |

### Sound cues

Open **Settings → Extensions → Sounds** and turn the extension on to hear sound cues.
Turning it off silences both cues. Sounds is off by default; the first browser with an existing
sound preference migrates that preference into the shared extension switch. An explicit extension
choice always wins, so another browser’s old preference cannot change it.

For **Session finished** and **Session needs you**, choose **Upload audio** to select a browser-supported
audio file up to 1 MB. **Preview** plays the selected cue before saving, and **Use default** restores
its built-in tone. Press **Save** to keep the changes. Files are stored on the server and shared
across browsers; turning the extension off keeps the uploaded files for next time.

## Minimal external extension

An installable repository needs `package.json` and an `index.js` with a default manifest export, plus
`package-lock.json` if it declares any runtime dependencies. Agent Wrangler reads the package declaration before executing extension code.

```json
{
  "name": "agent-wrangler-example-extension",
  "version": "1.0.0",
  "type": "module",
  "wranglerExtension": {
    "id": "example",
    "label": "Example",
    "description": "Adds an example capability to Agent Wrangler.",
    "author": "Your team",
    "requires": [],
    "engines": { "wranglerApi": "^1.31.0" },
    "earlyAdopter": { "branch": "next" }
  }
}
```

```js
export default {
  id: 'example',
  label: 'Example',
  description: 'Adds an example capability to Agent Wrangler.',
  author: 'Your team',
  requires: [],
  engines: { wranglerApi: '^1.31.0' },
  earlyAdopter: { branch: 'next' },
  defaultEnabled: true,
};
```

`earlyAdopter` is optional (1.39.0). Its `branch` must be a branch name `git check-ref-format
--branch` accepts and not start with `-`, and the two copies must match.

To list a public extension under **+ Add extension**, add the `agent-wrangler-extension` topic to its
GitHub repository.

The directory `<id>`, `wranglerExtension.id`, and runtime manifest `id` must agree. IDs begin with a
lowercase letter and contain lowercase letters, digits, or hyphens. A lockfile is required only when
`package.json` declares `dependencies`, `optionalDependencies`, `peerDependencies` or
`bundleDependencies`; create one with `npm install --package-lock-only`. A dependency-free extension
may omit it, and install then skips `npm ci`.

Supported manifest contributions are:

| Contribution | Manifest field / implementation |
| --- | --- |
| MCP tools | `tools`; `server/mcp/tools/` provides core examples |
| Control messages | `handlers`; `server/control/handlers/` provides core examples |
| State and storage | `stores`, `graph` |
| Session lifecycle | `session` hooks |
| Periodic work | `sweeps` |
| Runtimes | `runtimes`: where a session's agent runs, offered in the dispatch dialog's Runtime select and `spawn_session`. See [Runtimes](#runtimes) |
| Agent skills | `skills/<name>/SKILL.md` plus the manifest's `skills` list |
| Extension settings | `settings` (`text`, `textarea`, `number`, `toggle`, `select`, `list`), read through `host.settings` |
| Browser UI | `client`, optional `styles`, and slots from `public/slots.js` |
| Themes | `themes`: a directory of `<id>/theme.json` + assets, offered in Settings › Appearance. See [Themes](#themes) |
| Core access | `requires`, served through the versioned host API in `server/host-api/` |

### Themes

`themes` (1.43.0) names a directory inside the extension, such as `themes: 'themes'`. Each
subdirectory is one theme: `<id>/theme.json` with
`name`, `icon` and `base` (`dark` or `light`), optional `colors`, `font` and `background`, and
`assets` (`wallpaper`, `iconImage`) naming files beside it. The folder name is the theme's id, which
is what a browser saves as its choice, so keep it stable across releases.

A theme starts from its base and overrides only what it sets. The `light` base is the built-in Light
theme and the `dark` base is the built-in Dark theme, so a light-based theme inherits Light's fonts,
reading column and colours unless it sets its own. Each key in `colors` becomes the CSS variable of
the same name with `--` in front, and `font` sets `--font`. Besides the core colours (`bg`, `surface`,
`surface-2`, `fg`, `accent`, `blue`, `green`, `red` and so on, which the worked examples show), a theme
can set these reading and detail variables:

| Key | What it controls | Default when unset |
| --- | --- | --- |
| `font-mono` | Monospace font for code, the terminal and command output | The system monospace font |
| `font-features` | `font-feature-settings` for the UI font, such as `"cv05", "cv08"` | `normal` |
| `numerals` | `font-variant-numeric` for card, chat footer and usage numbers, such as `tabular-nums` | `normal` |
| `prose-leading` | Line height of chat messages | `1.62` |
| `prose-gap` | Space between paragraphs and lists in chat and file views | `0.6em` |
| `heading-tracking` | Letter spacing of chat headings | `normal` |
| `chat-measure` | Maximum width of the chat column and message box, such as `68em` | `100%` (full width) |
| `code-fg`, `code-bg`, `code-border` | Inline code and code blocks. `code-bg` also colours command output | `blue-fg`, `surface-2`, `border-muted` |
| `bubble-bg`, `bubble-border` | Your own messages in the chat view | `surface-2`, `border-muted` |
| `link-fg`, `link-decoration` | Links in chat and file views. `link-decoration` is a `text-decoration` value | `blue-fg`, `none` |
| `branch-fg` | Branch names on cards, including `main` | `purple`, and `blue-fg` for `main` |
| `selected-tint` | How strongly the selected card is tinted with `blue` | `18%` |
| `green-bar-on`, `snooze-on` | Text on the green working bar and on the snooze or warning fills | `bar-on` |

The defaults in this table are the Dark base's. Light sets most of them, so read the `body.light`
block in `public/styles.css` for the values a light-based theme inherits. A light theme with
translucent surfaces will usually want to set `code-bg` and `bubble-bg` to one of its own tints, as
Pink and Pixel Cats do.

While the extension is on, its themes appear in Settings › Appearance and in `/api/styles`, and
their declared assets are served from `/styles/<id>/<file>`. `theme.json` itself and any file the
manifest does not declare are never served. Turning the extension off removes its themes from
every open board within a tick. A browser that had one selected shows Dark but keeps its saved
choice, so turning the extension back on brings the theme back.

When two sources offer the same theme id, the first in this order wins and the others are hidden:

1. Extension themes, in extension load order: core extensions first, then installed ones.
2. Hand-placed themes in `~/.agent-wrangler/custom-styles/`.

A theme with an invalid `theme.json` is skipped and logged, and the next source's theme with that id
is used instead.

To let people switch single themes off, give each one a `toggle` setting whose `theme` (1.46.0) is
that theme's id. Unset counts as on. Set to false, the theme leaves the picker and `/api/styles`, its
assets stop being served, and the next source's theme with that id is used instead, as for an
invalid one. Each theme id can be named by one setting only, and only on a manifest with `themes`.
The core Themes extension marks its toggles `hidden` and draws them in a `settings.panel` with
`api.themeButtonHtml`.

An extension that lists themes in its own UI can draw each one as the picker does with
`api.themeButtonHtml(style, { active })` (1.44.0): `style` is an `/api/styles` entry, or a theme's
`theme.json` with its `id` added (for a theme that is switched off and so not listed), and the result
is a `<button class="theme-row" data-id="…">` with the theme's icon on a tile in its own colours, its
name and a strip of its accent, green and red. The button handles no clicks itself.

For development, place it under `<AW_DATA_DIR>/extensions/<id>/` and restart. Hand-placed extensions
have no provenance or panel updates; use an isolated `AW_DATA_DIR`.

## Authoring rules

- Keep manifest imports independent of the server entry, `session-manager`, `state-reader`,
  `tmux-scraper`, and `server/host-api/**`; use the capability-gated `host` object.
- Declare every capability in `requires`; undeclared host surfaces are structurally absent.
- Keep `package.json`'s `wranglerExtension` aligned with the manifest; runtime capabilities cannot be
  broader.
- Declare `engines.wranglerApi` (optional) in both places: the `package.json` copy lets install and update
  refuse an incompatible version before asking for consent, and the manifest's copy is checked again
  after consent and at every boot.
- Declare `earlyAdopter.branch` (optional) in both places too: the `package.json` copy is what is
  consented to and recorded, so a reinstall can clone that branch before any manifest is imported.
- Put browser assets under `public/`. Third-party strings render as text; homepages must use `https://`.
- Handle cleanup explicitly: uninstall removes the extension and provenance, not files it wrote elsewhere.

### Session launch capabilities

| Capability | Host surface |
| --- | --- |
| `sessions:spawn` | `host.sessions.spawn(options)` launches a session with the supplied dispatch fields. |
| `sessions:env` (1.48.0) | `host.sessions.launchEnv({ agent?, sessionId?, ext? })` collects a headless environment for any card, including credentials from other extensions, rejecting a deliberate hook refusal. |

The remainder is the maintainer reference. Read it before changing `server/extensions/**`,
`server/host-api/**`, `public/slots.js`, or `public/extensions*.js`.

## Internal architecture and invariants

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
  (`execFile`, never `shell: true`). `package-lock.json` is **mandatory whenever runtime
  dependencies are declared** and its absence then refuses the install before the
  disclosure — an unpinned dependency set cannot be disclosed honestly, so there is
  nothing to consent to. With no runtime dependencies declared the set is provably
  empty, so a missing lockfile is accepted and `npm ci` is skipped. The subprocess
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
- **An install or update the host API version does not serve is REFUSED, never
  applied.** Applying it would replace a working version with one that fails at
  activation or the next boot (see the failure posture below). `ext-install` checks
  the declaration's `engines.wranglerApi` copy right after `readDeclaration`, before
  the disclosure; `ext-consent` checks the imported manifest's own range after
  `assertManifestMatchesDeclaration` and before anything touches the installed
  directory, which catches a repo that declares it only in `index.js`. Either way the
  staging clone is removed, `failed` is broadcast (releasing the lock and advancing
  **Update all**) and the reply is `ext-install-incompatible` `{ id, update, range,
  hostVersion, message }` — a refusal frame rather than a thrown error, which the
  panel shows on the row in place of the update button. `ext-check-updates` stays
  `ls-remote` only, so it cannot know a remote commit's range: the button is offered
  and the refusal arrives when it is pressed.
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
  "Check all" is one `git ls-remote` per installed extension, on demand, nothing
  logged, and a record-less extension is skipped. The only background check is the
  core update tick in Notify or Auto mode (`extensions/update-check.js`), which the
  user opted into there: the same `ls-remote`, plus a shallow fetch into the
  installed clone to count the missing commits, once per new remote head. It
  never installs on its own account; Off keeps extensions strictly on demand.
- **Auto-update is a PER-EXTENSION opt-in on the provenance record
  (`autoUpdate`, strictly `true`), off for every install including ones made
  before it existed, with no global switch.** It lives on the record because
  only a record with an `originUrl` can be updated at all: `setAutoUpdate` refuses
  anything else, so a builtin or hand-placed extension cannot hold it, and
  uninstall removes it with the record. `ext-consent` carries it over on an
  update and a fresh install starts with it off. Turning it on goes through a
  confirm carrying `AUTO_UPDATE_WARNING` (`public/extensions-panel.js`), which,
  like the trust statement, must not be softened. The tick hands an outdated
  opted-in extension to `autoUpdateExtension` (`extensions-install.js`), which is
  **`ext-install` then `ext-consent` run back to back through the same handlers**,
  never a second install path: same clone, lockfile, host API checks and install
  lock (a held lock skips it until the next tick). The only thing skipped is the
  modal, and only when it has nothing new to ask: a disclosure with
  `reconsentNeeded` (or a changed id) is cancelled and the update is left on the
  row with the reason as `autoUpdateBlocked` (a host API refusal arrives as
  `incompatible`, as for a human update). Progress frames are kept off the board;
  only a finished update's `ext-install-done` (`automatic: true`,
  `restartRequired`) is broadcast, so every tab gets the restart affordance. The
  restart semantics below are unchanged: updated code loads at the next start.
  The check returns what it applied as `autoApplied`, and `update-service.js`
  keeps those ids pending and restarts through the same `onApplied` →
  `exitForRestart` path as a wrangler update, on the same terms: only with
  `canRestart` (`restartSupported()`) and only while `isQuiet()`, retrying
  every `restartRetryMs` while busy. It is called at most once per process, so
  several extensions, or a wrangler auto-apply in the same tick, mean one
  restart. Without `canRestart` nothing restarts, as before. A human install
  or update never schedules it.
- **Early adopter is a PER-INSTALL opt-in on the provenance record too**
  (`earlyAdopter`, strictly `true`), next to the branch the consented version
  declared (`earlyAdopterBranch`, from `readDeclaration`; `ext-consent` refuses a
  manifest whose `earlyAdopter.branch` differs from it). `setEarlyAdopter`
  refuses a record with no `originUrl` or no branch, and `trackedBranch(record)`
  is the one reader: the branch while opted in, else null. Every git path takes
  it as `{ branch }` (`install.js`): `cloneTo` adds `--branch`, `lsRemoteHead`
  asks for `HEAD` and `refs/heads/<branch>` in one call and prefers the branch,
  `countCommitsBehind` fetches `refs/heads/<branch>`, and each falls back to
  `HEAD` when the remote lacks the branch (`remoteHasBranch`). `ext-install`
  looks the branch up from the record whose `originUrl` is the frame's URL, never
  from the frame. `isValidBranchName` (`server/worktree.js`) is checked at the
  manifest, the declaration, the record and again before git sees the name, which
  only ever reaches git as one argv element or `refs/heads/<name>`. With no
  branch every argv is exactly what it was before. The host draws no UI for it;
  `ext-set-early-adopter` is sent only by the client `api.earlyAdopter.set`.
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
  button, above the detail pane (a restart is a whole-wrangler action, so several
  pending extensions must not each draw their own), in
  the amber `--warn`/`--warn-fg` role rather than Uninstall's danger red; the detail
  pane and the notice above it still say what is waiting on it. The button exists ONLY
  under a supervisor.** Under one, an update's consent modal makes **Update & restart**
  its primary button (`consentButtonLabels`), so the restart is not a second thing to
  notice; **Update without restarting** leaves the panel button as the fallback. The
  client sends `restart-server` only after that update's `done` progress frame, never
  on the click, so a failed or cancelled update restarts nothing, and an Update all
  queue restarts once, when it drains, if any update approved with restart landed. `AW_SUPERVISED=1` is set by whatever brings the process
  straight back: `scripts/wrangler-start.sh` (which both the launchd plist and the
  systemd unit exec) and a Homebrew service. So the flag means "something will
  restart me", never "I am on macOS" and never "I may apply a Git update" (that is
  `AW_GIT_UPDATES`). Under `npm start`, a bare `bin/agent-wrangler` or a dev instance
  (`AW_DEV`), an exit is a shutdown with nothing to return the board, so `restart-server` refuses (it checks
  `ctx.canRestart`) and the client (`config.canRestart`) never draws the button. The
  server reads the flag once at startup and keeps it out of tmux panes, so a dev
  instance started from a pane doesn't inherit the button either; see
  [Install signals](install-signals.md). The handler (`control/handlers/restart.js`) acks BEFORE the exit is armed
  (the socket dies with the process) and the exit itself lives in `index.js`'s
  `ctx.restart`, which calls `shutdownLog.noteReason` first — a self-inflicted exit
  with no reason logs exactly like the hard kill an absent reason is supposed to
  mean. The board's own pending notes (an uninstalled row, a finished install) are
  cleared by the next `config` frame, which is the first frame of every reconnect
  and therefore the only reliable "the restart happened" signal a client gets.
- **The Extensions tab is ONE list, and every row is a `.setting-row` carrying
  `data-id="ext:<id>"`.** Rows are grouped into Core/External sections by
  `entry.external`; the row markup and flip path are unchanged. Builtin and installed extensions used to render through two
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
  number, `maxLength`/`pattern` on text, `maxLength` alone on a `textarea`, `maxItems` plus per-item
  `maxLength`/`pattern` on a `list`,
  `options` on the `select` type — and
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
  **`textarea` (1.16.0) is multi-line prose, and it differs from `text` in three
  deliberate ways**: its cap is `MAX_TEXTAREA_LENGTH` (20000, via `maxLengthFor`)
  because a written-out process does not fit a URL-sized field; it takes no
  `pattern`, since a full-string regex over paragraphs is not a constraint anyone
  means; and it commits on `change` (blur) ONLY — Enter is a newline, so the
  row's Enter-commit never fires from inside one. Because blur is its only commit,
  the panel blurs whatever field has focus before it remounts (`commitFocusedField`)
  on its own. With no declared `maxLength` the field still carries the server's
  cap (`MAX_TEXTAREA_LENGTH`, mirrored in `extensions-panel.js` and asserted
  equal by its test). The value is stored verbatim, untrimmed.
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
  moved. On the client the rows are drawn inline in the selected extension's detail
  pane under **Settings** (omitted when it declares none), with its own
  `settings.panel` contributions above them and a **Save** button for those that have a `save`. The
  remount signature excludes `settingValues`, so a value landing never rebuilds
  a field someone is typing in. A QUARANTINED extension keeps its Settings section with its rows
  DISABLED, which says "this is what it would want" where a hidden section would
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
  skillsFor, codexPolicy, hideTool, graph, session, sweeps, client, styles, themes}`) is validated at boot (`validateManifest`,
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
  so naming a sibling's skill does
  nothing, and a throwing gate suppresses nothing rather than stripping a real
  launch. It reaches the adapters as `disabledSkills`, threaded
  through `buildLaunch`/`buildResume`/`buildFork` on BOTH adapters
  into `mandatorySkillPrompt`/`codexSkillCatalog`/`extensionSkillPluginDirs` — a
  fourth launch path must thread it too. The `_extLaunchSkills` seam is consulted before the adapter
  builds and, in dispatch, deliberately AFTER `onBeforeDispatch`, so a gate can
  read back what that hook just persisted; `entry` is null at dispatch, the
  existing entry at resume and the PARENT's at fork (a fork's own entry is
  written after launch). **`codexPolicy` (1.12.0) answers a Codex launch's
  autonomy, per launch, at the same three points as the skill gate** — with
  `{ phase, sessionId, entry, ext }` (`ext` the extension's own façade; `entry`
  null at dispatch, the existing entry at resume and the PARENT's at fork, where
  `parentId` rides too). The answer is `{ sandbox, approval, approveForMe,
  bypass }`, validated by `server/extensions/codex-policy.js`: an invalid field
  is dropped and the rest applies, bypass is exclusive, and a combination Codex
  refuses (its `INCOMPATIBLE` table) drops the named field. The first answer
  wins and a later one is logged as a collision; a throw or unusable answer falls back to the session's core Sandbox choice
  (Locked to worktree for legacy sessions: `--sandbox workspace-write --ask-for-approval never`
  plus the network grant). It is synchronous (a Promise is dropped) and consulted only
  for Codex, through the `_extCodexPolicy` seam; a new launch path must thread `codexPolicy` too.
  The dialog's Sandbox chooser is a core preview and does not replace extension Advanced controls.
  The session retains `sandboxMode` as its fallback and records `codexPolicy`, `codexPolicySource`
  (the winning extension id, or `core`) and `codexPolicyFlags` for the actual launch. These are
  available in graph sessions and session details when an adapter builds the launch;
  a runtime supplying its own command does not claim adapter policy flags. The hook's answer shape
  and first-answer order stay the same. Disabling a policy extension restores the saved core choice on the next launch.
  Agent discovery includes optional `launchModes: { label, field, overridable?, modes }`; each mode
  declares `id`, `name`, `hint`, `icon`, `default?`, `folders` and `flags`. The dialog renders those
  declarations and uses the same flags as the adapters, hiding the section when absent.

  **`hideTool` is the one surface that shapes tools an
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
  `renderFocusedTile`) already end with. **`BUILTIN` holds the shipped
  extensions, each in `server/extensions/builtin/<id>/`** (manifest `index.js`
  exporting its absolute `dir`, plus `store.js`, `tools/`, `handlers.js`,
  `skills/`, `public/` and its tests). **`checklist`, `todos`, `adversarial-review` and `task-memory` are the shipped set**, and
  `index.test.js` asserts the exact id list so a stray manifest can't register
  tools and handlers on every install unnoticed. **Migrating a flagged feature
  (archive-review) is: move its code under `builtin/<id>/`, a
  manifest + `BUILTIN` row, delete its accessor, `set-<x>-enabled` handler and
  settings def, and add a `{ oldKey, extId }` row to `RETIRED_FLAGS`** — never a
  fresh `if (id === …)` rung in `app.js`, since `setExtensionDefs` renders the
  Extensions tab off `graph.extensions`.
- **`RETIRED_FLAGS` (`server/config-store.js`) carries a retired core flag over to
  `extensions.<id>` at boot.** `applyRetiredFlagMigrations()` runs in
  `server/index.js` BEFORE `primeExtensions` reads config. Only an explicit
  `false` moves (`extensions.<id> = false`); `true`/missing/garbage just drop the
  old key, and an explicit existing `extensions.<id>` boolean wins. Idempotent;
  rows stay forever. Current rows: `checklistEnabled` → `checklist`, `taskMemoryEnabled` → `task-memory`.
- **The checklist is a reference builtin.** Store, four MCP tools, four control
  handlers, the `checklist` skill (plus its `WRANGLER.md` nudge), an `onPurge`
  session hook (purge is the only thing that drops a list; archive keeps it), a
  `graph` contributor for `checklists`, and a client half (`panel.section` for the
  panel, `panel.metaChip` for the done/total chip). `requires` is just
  `board:rebuild`. It still writes `<DATA_DIR>/checklists.json` — the store is
  deliberately NOT under a per-extension directory, so existing data loads
  unchanged — and its legacy `wrangler.checklistOpen` / `wrangler.checklistShowDone`
  localStorage keys are kept through `api.storage.raw()`. Disabling it unregisters
  the tools, grant, skill, handlers, panel and chip together through the loader.
- **`todos` is the reference builtin for task-keyed data**: store (`todos.json`), WS handlers, MCP tools, a graph key, `onTaskDelete`,
  a shipped skill, a one-time migration from `tasks.json`, and a client that fills
  `task.body` (below). Disabling it removes the zone, tools and skill and tiles size as
  if there were no TODOs; `todos.json` is never deleted. The core `tasks.json` keeps
  its legacy `todos` field as an opaque pass-through for one release (so a downgrade
  or a failed migration retry still finds it); drop it afterwards.
- **`onTaskDelete({ taskId, host })` (1.15.0) is a manifest hook for data keyed by
  task id.** The `task-delete` control handler removes the task from core first
  (`TaskStore.deleteTask`, which unassigns its sessions), then
  `ctx.ext.fireTaskDelete` (`createTaskDeleteNotifier`) awaits each enabled
  extension's hook sequentially with that extension's own façade. Errors are logged
  and isolated per extension; disabled, uninstalled and quarantined extensions are
  never asked (unregister removes the hook). **`host.tasks.adhocId`** (under
  `tasks:read`) is the reserved id of the Unassigned tile (equal to core's `ADHOC`),
  so nothing hard-codes `'adhoc'`.
- **`task.body` (1.15.0) is a slot with one host PER TASK TILE, Unassigned included.**
  `cards.js taskBodyHostHtml` draws `.task-body-ext[data-task-body]` and `app.js
  mountTaskBodies` reconciles them with `syncHosts` from `wireGridEvents` (the card.pill
  pattern). The per-host subject is `{ taskId, adhocId, container }`, passed as
  `mount(el, api, ctx)` and `update(el, ctx, graph)`; `taskId` is the reserved
  `adhocId` for Unassigned. A contribution may carry `weight(taskId, graph)`:
  px of tile height, summed by `slots.taskBodyWeight` into `layout.tileSpan`'s
  `bodyPx`. It runs per tile per layout pass, so it must be synchronous and cheap; a
  throwing weight counts as 0 and is reported once, NOT removed (unlike mount/update,
  it runs in a measurement pass). Weight reaches the capped secondary bucket, like
  snoozed rows. Core cannot know what a body drew, so an extension that fills a tile
  hides the empty-state hint itself (`.task-body:has(...) .cell-empty-body`).
  `api.requestBoardRender()` redraws (and re-sizes) the board for content changes.
- **`api.claimDrag(el)` makes a drag extension-owned.** It sets `data-ext-drag="<extId>"`
  on `el` and returns an unclaim function; `gridEditing()` in `public/app.js` returns
  true while any such element exists, so the ~4s poll does not rebuild the grid
  mid-drag. Call it on `dragstart`, unclaim on `drop`/`dragend`. A non-element is
  reported and ignored, and `removeExtension` clears the extension's claims so a
  disabled extension cannot freeze the board. Focus inside `#panel-sections` is
  already covered generically by `gridEditing`, so a panel section's inline input
  needs nothing extra.
  The `todos` extension claims its host only for the length of a row drag (set in
  its `dragstart`, released on `dragend`), so the cell highlight stands aside and
  re-renders hold while a row is in flight.
- **`api.openDispatch({ taskId, intent, lockTask, cwd, images })` (1.15.0)** opens the dispatch
  modal and returns a promise: the `dispatched` ack once the human launches, `null` if
  the modal is cancelled or superseded. Concurrency (`public/dispatch-waiter.js`): a
  second call while the first modal is merely open REPLACES it (the first resolves
  null); while a launch awaits its ack the second call REJECTS, since two acks cannot
  be told apart. An error reply to a launch whose modal is still open makes it
  retryable; a closed one resolves null. This replaced core's `pendingTodoConsume`.
  **`cwd` and `images` (1.36.0)**: `cwd` (string) prefills the working-folder field
  in place of the task's usual folder, and the human can still change it. `images`
  is an array of names from `api.images.stage` (pass each result's `name`); they
  appear in the prompt box as chips, exactly as if pasted: removable, and counted
  against the same limit of 8 per first prompt, so any beyond it are dropped with
  a toast. A non-string `cwd` or an `images` that is not an array of non-empty
  strings rejects before the modal opens. The names' shape is not checked in the
  browser: at launch the server claims only minted, still-staged names and skips
  the rest. Staged names are single-use, so stage again for each open. Images need
  a local launch, as for pasted ones.
- **`api.dispatch.submit({ model?, effort?, runtime? })` (1.28.0)** launches the dispatch
  modal that is ALREADY open, as Launch would, optionally on a given model and
  effort. It works only in launch mode (rejects when the modal is closed, or in
  schedule or sub-agent mode). `model` must be an option the modal offers, and
  `effort` one it offers after that model is selected; anything else rejects
  without sending. Both are marked as the human's explicit choice. Core
  validation still applies (blocked folder, bad worktree, …), and a blocked
  launch rejects `dispatch blocked by validation`. It resolves once the
  dispatch is SENT, not launched: a worktree or workflow dispatch is still
  pending then, so an extension that needs the `dispatched` ack opens the modal
  with `openDispatch` and awaits that promise. `dispatch.field` contributions'
  `fields()` merge into the payload as usual.
  **`runtime` (1.33.0)** selects an offered Runtime option first (`local`, a
  built-in, or an extension's), after `model`, so a runtime the model's agent
  can't use (one whose `agents` leaves it out) rejects `runtime not offered for this model`. For an extension
  runtime that owns its models (it defines `validateModel`; the client sees
  `ownsModel: true` on `graph.extensions[].runtimes`), `model` is NOT checked
  against the core select: it is sent as `ext.<extId>.model`, merged over that
  extension's own slice, exactly as `spawn_session` hands it over, and the
  runtime's preflight validates it. Without `runtime` the modal's current
  selection is used, which may be a runtime the dialog restored from the last
  launch — pass `runtime: 'local'` to be sure.
- **`api.dispatchFields.mount(el, ctx, { saved = null } = {})` (1.48.0)** hosts the
  live `dispatch.field` contributions in an extension's own dialog, in anchor order,
  with independent element state and no `hides` veto; `ctx` carries the host's own
  `mode` (for example `job`), `draft: { agent?, model?, runtime?, cwd? }` and optional
  `agents` (defaulting to the board's current list).
  The returned `{ read(), validate(), update(ctx, graph), unmount() }` uses the board's
  registration-order payload merge and first validation message, passes each `open`
  only its own cloned slice of `saved`, and tears down on `unmount` (`read()` then
  returns `{}`); later registrations wait for a re-mount, and a throwing contribution
  is reported and removed from every host.
- **Graph `effort` (1.28.0).** Board session nodes and `graph.history` nodes
  carry `effort`, the effort the session was launched with (`null` when none
  was recorded, e.g. the agent's default or an adopted session). Resume and
  fork keep the original's. `dispatch.field`'s `update(el, ctx, graph)` always
  gets the cached `history`, even on a tick whose graph did not resend it.
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
  `#m-model` and `#m-runtime` change listeners (1.19.0: a contribution can react
  to the runtime choice), `syncWorkflow` and `syncClientExtensions`, and in
  `subagent` modalMode it is called with an **EMPTY host list** so contributions
  tear down by omission rather than sitting invisible inside a hidden block.
  Optional `validate(el, ctx)` (1.47.0) returns a non-empty message to toast and block
  immediate dispatch, including `api.dispatch.submit`, which rejects with
  `dispatch blocked by validation`. Blank or non-string answers allow submission;
  unmounted fields are skipped, and a throwing validator is reported and its
  contribution removed, as with `fields()`.
  A contribution can be mounted once per host (1.48.0), including the board's dialog
  and extension-owned dialogs; keep all field state on the supplied element.
  **The veto is TWO keys and fails CLOSED on authority, OPEN on health.** The
  manifest's `hideDispatchField` is the DISCLOSURE — a static array (never a
  function: the board must know what an extension may suppress before any of its
  code runs), validated against the server-side `DISPATCH_FIELDS` set, riding on
  the `extensions` announcement and `graph.extensions` exactly as `handlerTypes`
  does. A contribution's `hides` is the per-contribution USE, filtered against
  it, and an undeclared name is DROPPED and reported: the browser half may never
  widen what the server half disclosed, the same rule as `send`. Since 1.19.0
  `hides` may also be a function `(draft) => names`, called with the ctx's core
  draft on every veto pass, so a veto can follow another field (hide the
  worktree row only while a given runtime is selected); its answer is filtered
  exactly like the array, and a throw or a non-array return REMOVES the
  contribution, as a throwing `fields()` does. The veto holds
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
  load on. `DISPATCH_FIELDS` is deliberately small — each name is a commitment
  that `app.js` has a row id in `DISPATCH_FIELD_ROWS` and `index.html` a
  `.dispatch-field` wrapper, so widening it is a MINOR plus three edits.
  `worktree` (1.19.0) is the fifth, for a runtime that cannot honour a worktree:
  its wrapper `#m-worktree-box-row` sits OUTSIDE `.worktree-box`, because
  `syncWorkflow` already toggles the box's own `hidden` and the two must never
  undo each other. `quickLaunch` (1.28.0) is the sixth: the ⌘1–⌘3 quick-launch
  buttons, wrapped in `#m-quick-launch-row` (outside `#m-quick-launch`, which
  `syncQuickLaunch` hides in schedule mode). Hiding it also turns off core's
  ⌘1–⌘3 binding, so an extension's own `keys.bind` on those combos in the
  `dispatch` scope owns them, for an extension that ranks its own quick
  launches with `api.dispatch.submit`. Since 1.19.0 `fields(el, ctx)` and `ext(el, ctx)` also get
  the ctx as a second argument.
  **`open(el, ctx)` (1.20.0) is the per-open call, and it exists because
  neither `mount` nor `update` can be one.** The anchor hosts are static
  markup, so `mount` is once per host element and the last open's typed value
  survives; `update` runs on every sync — twice inside `openModal` alone, then
  on every model, runtime or mode change. `openModal` calls
  `openDispatchExtFields` exactly ONCE, after its final sync and every core
  reset, just before the modal is unhidden, and `slots.openDispatchFields`
  calls each mounted contribution's `open` with update's ctx plus `editing`
  (`modalMode === 'schedule-edit'`) and `saved`: that extension's OWN slice of
  the saved dispatch's `ext` bag, a fresh copy, `null` when there is none. It
  is narrowed in slots for the forced-namespace reason below, and `editing`
  exists so a `null` `saved` can mean "this schedule sent nothing" rather than
  "apply your default". A separate call rather than a flag on update's ctx: the
  flag would have to be true on exactly one of `openModal`'s two syncs, which is
  the ordering this replaced extensions relying on. A throwing `open` REMOVES
  the contribution, and `openDispatchExtFields` re-runs the veto so its hidden
  rows come back before the modal is shown. `openDispatch`'s own overrides
  (`cwd`, `intent`, a review's model) land after `open`, and reach a
  contribution through `update` like any other change.
  That slot itself has no builtin user; its coverage is test fixtures.
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
  guards cannot drift between the two. It feeds the tile's right-click menu
  (`app.js openTaskMenu`) and the header menu (`openTaskActionsMenu`) for named
  tasks; Unassigned receives these extra actions in its right-click menu. The right-click
  menu carries core's Minimise too; `extTaskMenuItems` drops the `Minimise` item
  contributed by the `minimise-task` extension (matched on extension id and label,
  in both menus) so that extension still loads without a duplicate. The no-task
  tile is included, as `adhoc: true` with the reserved `ADHOC_ID`, because it
  can be minimised too. **`api.minimiseTask(taskId)`** (1.11.0) is the action it
  exists for: base-api-only for `openSession`'s reason (the minimised set is
  `app.js` view state, not a frame `send` could carry), and it returns a boolean
  because `minimise()` silently refuses the last visible tile — an extension
  must be able to tell. `app.js` also refuses an id not in `currentOrder()`, or
  an archived task would sit in the minimised set until the next prune.
  **`api.openTask(taskId)`** (1.24.0) is `openSession`'s task counterpart: it
  shows the task's tile, restoring it from the tray if it was minimised, and
  scrolls to it with the restore pulse. It returns whether the task is on the
  live board; an archived or unknown id toasts "Task is not on the board". Opening
  a session likewise restores its task's tile first, so a session in a minimised
  task is no longer opened behind the tray. A notification's "Go to" is an
  ordinary action that calls one of these when its answer comes back.
  **`api.openDiff(sessionId, { onClose })`** (1.27.0) does what `openSession`
  does, then opens that card's diff panel over the grid (after the restore, for
  an archived card). `onClose` is called once, when that panel closes by any
  route, so an extension can reopen whatever the reader left. It never fires if
  the panel never opened (a refused restore) or a later `openSession`/`openDiff`
  replaced the request first.
- **`board.tray` (1.53.0)** is an exclusive mount-style slot for the bottom strip.
  Register `{ id, mount(el, api, ctx), update?(el, ctx, graph), unmount?(el),
  minimiseItem?(task, graph, api), backgroundItem?(graph, api) }`.
  Its `ctx` is `{ tasks, minimisedIds }`:
  `tasks` contains `{ id, name, adhoc }` in live board display order, including
  Unassigned (`id: 'adhoc', adhoc: true`) and excluding archived/deleted tasks;
  `minimisedIds` is an array of the browser's current minimised task ids.
  Both are fresh snapshots. Core owns that set; enabling a tray does not change it.
  `mount` receives the initial context, then `update` runs on every board render,
  including graph changes, reorder, Focus, keyboard focus navigation, task/session
  opening and bulk minimisation. New tasks are visible until explicitly minimised.
  If housekeeping removes the last visible task, core clears the minimised set.

  The first registered contribution wins; collisions are reported once per pair.
  Later contributors remain unmounted until an earlier one is removed or fails.
  The winner keeps its element across board renders and owns the entire strip,
  which is visible even with no minimised tasks. Core's pills and Restore all are
  absent while it owns the strip. Mount runs before the strip is placed on the board;
  layout-dependent work belongs after placement (for example in an animation frame).
  Disable, uninstall or failed module loading unmounts and removes its contribution.
  A throwing `mount` or `update` does the same, then tries the next contributor in
  registration order; with none left, core's strip returns in that render. Unmount
  errors are reported but do not prevent cleanup. Re-enabling registers afresh.

  Only the mounted tray owner's `minimiseItem` can replace core's **Minimise**,
  in both the header menu and the tile right-click menu, including Unassigned.
  Return `{ label, icon?, run(event) }`, or `null` to keep core's entry. Labels are
  escaped text, icons follow the existing menu markup convention, and `run` errors
  are caught and reported. **Focus** and other menu actions remain available.
  The owner's optional `backgroundItem(graph, api)` adds one action beside
  **New task** in the blank task-view right-click menu. It receives no task target
  and returns the same item shape, or `null` to leave only core's action.
  A throwing menu callback or malformed item removes the tray contribution,
  leaves core's menu actions and requests a board render to restore the strip
  (or promote the next contributor). These guards apply to both callbacks.
  Ordinary `task.action` contributions cannot replace core's entry, contribute
  to the blank task-view menu or claim tray ownership.

  **`api.setMinimisedTasks(ids)` (1.53.0)** atomically replaces the whole browser
  minimised set. Pass an array of non-empty task id strings (including `'adhoc'`).
  Duplicate and non-live ids are pruned before checking the last-visible-tile guard.
  A request hiding every live tile, or malformed input, returns `false` without
  changing storage or rendering. Accepted requests return `true`; a changed set is
  persisted and rendered once, and an unchanged set needs no render. `[]` restores
  every task. This method is available to every client extension, like
  `api.minimiseTask`; only menu replacement is tied to tray ownership. Declare
  `engines.wranglerApi: '^1.53.0'` in both the runtime manifest and `package.json`'s
  `wranglerExtension` when using these hooks. Server host access still requires
  the capabilities listed in `requires`.
- **`api.agents()`** (1.25.0) returns the dispatch dialog's agent list —
  `[{ id, label, models: [{ value, label, default, autoEffort }], efforts: [{ value, label }], launchModes? }]`,
  the same list core's model select reads, sourced from the live model and
  price catalogs — as a fresh deep copy per call. A model's `autoEffort`
  (1.49.0) is the level the agent runs it at when a launch passes no effort
  ("Auto"), read from the user's and organization's settings (Claude: managed
  settings, a settings `env` block's `CLAUDE_CODE_EFFORT_LEVEL`, user settings,
  then the model's documented default; Codex: `config.toml`, then the model's
  catalog default), and is absent when unknown. **`api.agents.onChange(fn)`**
  fires (with its own copy) whenever the server re-sends the `agents` frame: on
  connect, and when a catalog refresh or one of those settings files changes it. It returns the unsubscribe
  function; subscriptions die with the extension, and a throwing listener is
  reported and kept. An extension with its own agent/model picker reads this
  instead of mirroring the vocabulary, which would drift on every model release.
- **`api.modelFront`** (1.56.0) shares core's committed benchmark data and pure
  model-front maths. Declare `engines.wranglerApi: '^1.56.0'` in both the runtime
  manifest and `package.json`'s `wranglerExtension`, retaining any other engine
  requirements. The object and its `data` are frozen, including nested rows.
  Data is bundled with the app; no extension installation or external request
  is needed to load it. Every data-reading method is bound to these rows;
  callers cannot substitute a dataset.

  `data` is `{ read, credit, benchmarks, models }`: `read` is the reading date,
  `credit` cites the benchmark sources and bundled LiteLLM price catalog,
  `benchmarks` records benchmark names, versions and weights, and
  `models[agent][model][effort]` is `[quality, usd, minutes]` per coding task.
  Quality is Terminal-Bench points (higher is better); dollars and wall-clock
  minutes are lower-is-better. These are coding-task measurements, not review
  quality scores. A **pick** is `{ agent, model, effort }`; a scored **point**
  adds `{ quality, usd, minutes, cost, time }`. `cost` and `time` are chart
  coordinates from 0–100 across all measured rows: logarithmic dollars and
  linear minutes. Returned arrays and points are independent of core's data;
  changing them cannot affect subsequent calls.

  | Function | Result |
  | --- | --- |
  | `scoreOf(pick)` | Score fields, or `null` for an unmeasured setting, including unresolved Auto. |
  | `dominates(a, b)` | Whether scored point `a` is at least as good on quality, dollars and minutes, and strictly better on one. Equal scores do not dominate each other. |
  | `frontOf(agents)` | Non-dominated measured settings offered by an `api.agents()` catalog, cheapest first (quality descending on a price tie). Honors both agent and model effort lists; unknown models and efforts are omitted. |
  | `fullFrontOf()` | The front over every measured row, installed or not, in the same order. |
  | `unavailableOf(front)` | Full-front points absent from the supplied front, matched by agent/model/effort. |
  | `curveOf(front)` | Points non-dominated on quality and dollars alone, cheapest first. Faster points below this curve still belong to the three-dimensional front. Equal quality/price ties are retained. |
  | `beatenBy(front, pick)` | The highest-quality point dominating the scored pick (cheapest on a quality tie), or `null` when none does or the pick is unscored. |
  | `nearestOf(front, point)` | Nearest point by Euclidean distance in plotted `cost` and `quality`, or `null` on an empty front. Ties take the first point. |
  | `autoEffortOf(agents, pick)` | A model's reported `autoEffort` when the pick omits effort or uses `''`; otherwise `''`, also when unknown. |
  | `resolvedPick(agents, pick)` | A pick with known Auto replaced by its actual effort; explicit efforts and unknown Auto are preserved. Call this before scoring or judging an Auto pick. |
  | `programmesOf(agents, front, programmes)` | Caller-named slots fitted to distinct points of strictly rising quality; each result is `{ name, ...point }`. |

  `programmes` is the caller's `{ both: [[name, pick], …], claude: […], codex: […] }`.
  The installed agent set chooses the slot names. Each slot prefers its own
  set's pick, then the same-named pick of an installed agent's set, then those
  models at nearby efforts, then the point nearest its target quality. Fitting
  fills as many slots as the front's distinct qualities allow before optimizing
  those preferences. Missing sets produce no slots. Core supplies no presets,
  default, naming or picker UI; those belong to the extension.

  ```js
  const agents = api.agents();
  const front = api.modelFront.frontOf(agents);
  const curve = api.modelFront.curveOf(front);
  const actual = api.modelFront.resolvedPick(agents, { agent: 'claude', model: 'opus', effort: '' });
  const score = api.modelFront.scoreOf(actual); // null when Auto is unknown
  const presets = api.modelFront.programmesOf(agents, front, MY_PROGRAMMES);
  ```
- **`api.runtimes()`** (1.33.0) returns the dispatch dialog's Runtime options,
  `[{ id, label, ownsModel, ownLaunch, agents }]` (`local` and the built-ins first, then enabled
  extensions' runtimes), as a fresh copy per call. `ownsModel` marks a runtime
  that defines `validateModel`, whose model `api.dispatch.submit` sends as
  `ext.<extId>.model`. `agents` (1.37.0) lists the agent ids the runtime takes
  (`null` for `local`, which takes every agent). `ownLaunch` (1.47.0) marks a
  runtime that builds its own command; it is `false` for `local` and `devcontainer`.
- **`api.keys.bind({ combo, scope, when?, run, description })`** (1.26.0)
  adds a keyboard shortcut through the board's keybinding registry
  (`public/keybindings.js`) and returns an unbind function. The manifest must
  declare every combo+scope it binds in a static `keybindings` array —
  `keybindings: [{ combo: 'mod+shift+l', scope: 'dispatch' }]` — and a bind
  not on that list is dropped and reported, the same disclosure rule as
  `hideDispatchField`. The server validates the array at load (a parsable
  combo, a known scope) and quarantines a bad one.
  - **Combos** are `+`-joined, case-insensitive: modifiers `mod` (⌘ on Mac,
    Ctrl elsewhere), `cmd`/`meta`, `ctrl`, `shift`, `alt`, then one key — a
    letter, a digit, `/ , . ; [ ] - = \``, or `enter`, `escape`, `left`,
    `right`, `up`, `down`, `backspace`, `delete`, `space`, `tab`. `mod+k` and
    `cmd+k` are different declarations.
  - **Scopes**: `dispatch` (the dispatch dialog is open), `modal` (any other
    dialog or the card menu is open), `board` (grid view, nothing typed into a
    text field), `global` (always considered, after the active scope).
  - **Precedence**: for a keypress, the active scope's bindings are tried, then
    `global`'s; within a scope extension bindings come before core. The first
    whose `when(e)` passes (or has none) runs, and the key is
    `preventDefault`ed. A `when` that returns false falls through to the next
    candidate, core included.
  - **Collisions**: if another extension already holds the same combo+scope,
    the later bind is dropped and reported; the first keeps it. A throwing
    `run` is reported and the binding kept. Bindings go when the extension is
    disabled or uninstalled.
  - Bindings are listed under the extension's label in Settings → Shortcuts.
  A manifest using either half declares `^1.26.0`.
- **Control handler `reply(payload)`** (1.35.0) is the third argument of an extension’s
  `handler(msg, host, reply)`. It sends only to the requesting control socket and forces the
  frame type to `ext:<id>`, delivered through the client’s `api.onMessage`. Use it for reads
  and request errors; `host.broadcast` remains the way to publish shared updates to all tabs.
- **`notification.cue`** (1.35.0) is a client value slot: `{ id, cue(kind, api) }`.
  Core calls it with `finished` once per poll with an eligible working → idle transition,
  and `needs-you` when a session raises its attention notification. Both honor focus-mode
  suppression before dispatch; the first board load does not emit finish cues. Extensions
  own their playback. A thrown or rejected callback is reported without interrupting
  the board or other contributors. Removing an extension removes its callbacks immediately.
  A manifest using this slot declares `^1.35.0`.
- **`api.earlyAdopter`** (1.39.0) is present only when the manifest declares
  `earlyAdopter.branch`: `branch` (that name), `enabled()` (this install's opt-in,
  read live from the announcement and the graph's `extensions[].earlyAdopter`) and
  `set(on)`, which takes a boolean and resolves with the stored value or rejects
  with the server's reason (for example a hand-placed install, which has no
  origin to follow). The board draws nothing for it, so the extension owns its
  own, typically hidden, switch. Turning it off changes nothing until the next
  update, which comes from the default branch.
- **`api.onThemeChange(fn)`** (1.39.0) calls `fn({ id, base })` whenever the
  board applies a different theme palette (`id` the style, `base` `'dark'` or
  `'light'`). Returns an unsubscribe function; listeners go with the extension. A
  manifest using either declares `^1.39.0`.
- **`api.onConnect(fn)`** (1.35.0) subscribes to subsequent control-socket connections,
  so a client can refresh shared state after reconnecting. Returns an unsubscribe function;
  disabling or removing the extension drops its listeners. It does not fire immediately on
  registration: a module should also request its initial state when it registers.
- **`api.settings()`** (1.13.0) returns the extension's own current setting
  values in the browser (a fresh copy, read from `graph.extensions[].settingValues`
  at call time; unset keys absent). It is what lets a `dispatch.field` PREFILL
  from Settings and send every value explicitly — before it, a server half had
  to fill empty fields from settings, so a dispatch could never send `false`
  for a toggle Settings had on. Since 1.14.0 it is a function WITH properties
  (still callable bare): **`api.settings.set(key, value)`** → Promise sends
  core's `ext-setting-set` with a `reqId` through the RAW base send (it is core's
  handler, not the extension's own type — safe only because slots forces the id
  and the server validates against that manifest's defs), resolving or rejecting
  on the matching `ext-setting-result` reply (10s timeout; a failure replaces
  the generic error toast); **`api.settings.onChange(fn)`** fires when a graph
  carries different `settingValues` for that extension than the last one (the
  existing rebuild is the broadcast — no new frame), with the same
  report-and-keep rule as `onMessage`, and dies in `removeExtension`.
- **Setting defs: `list`, `hidden`, `maxItems` (1.14.0).** A `list` value is an
  array of distinct strings (each ≤ `MAX_TEXT_LENGTH`, at most `maxItems`, itself
  ≤ 500 and legal on a list only); `ext-setting-set` copies it and rejects
  anything else — never coerces. `hidden: true` (boolean, any type) keeps a def
  off the Settings rows: it is a value the extension manages itself. A visible
  `list` draws an editor (one field per item, remove buttons, an add field)
  that commits the whole array on every edit.
- **`pattern` and `maxLength` on a `list` (1.21.0) constrain each item**, with
  the same full-string anchoring as on `text`. The editor mirrors both onto
  every field and refuses an invalid item before it is sent; the server check
  is the enforcement.
- **`settings.panel` (1.14.0) is the extension's own block in its Settings
  section**, above the manifest rows (`app.js extSettingsEl`). Single-host, via
  `mountInto(…, { onlyExt })`, so ONLY the owning extension's contributions
  mount there. Contract `{ id, mount(el, api), update?, unmount?, save?(el) }`.
  **Save writes panel contributions only**: when an extension has a panel with a
  `save`, a **Save** button follows it. `slots.savePanels` awaits each `save` in turn (a
  rejection leaves the panel as it is; the extension shows its own error), and
  `unmountHost` runs every `unmount` before the pane is rebuilt. A panel with no
  `save` commits as it changes (the Themes switches call `api.settings.set`), and
  with no such panel mounted there is no Save button (`slots.hasPanelSave`). Manifest rows
  commit on change and flash "Saved" (`flashSettingsSaved`). An extension should
  use manifest rows or a panel, not both: the section would carry two save models
  at once.
- **`registrar.api` (1.14.0).** The registrar a module's `register(registrar)`
  receives carries `api`, the SAME object (by identity) every contribution's
  `mount(el, api)` gets, so a module can call `api.cards.hideChips(...)` or
  `api.settings.onChange(fn)` at load time with nothing mounted. Capability
  gates apply unchanged, and `removeExtension` (disable, uninstall, failed load)
  drops its `onChange` subscriptions and hidden chips exactly as for a mounted
  contribution. `extensions.js` passes app.js's base api through
  `slots.forExtension(id, baseApi)`.
- **The chip veto (1.14.0) is presentation-only, and scoped to the board
  CARD.** Every core chip `sessionCardHtml` draws in `.card-meta` carries
  `data-chip` — `core:age`, `core:cost`, `core:model`, `core:tokens`,
  `core:compact`, `core:subagents`, `core:restarting`, `core:automerge`,
  `core:runtime`, `core:worktree`, `core:pr` (cards.js
  `CORE_CHIPS`, meta-row order). A `link.chip` contribution's chip is keyed
  `<extId>:<id>` (the Jira chip is `jira:jira`) and listed by `chips()` like a pill. A
  `card.pill` contribution's key is `<extId>:<id>` (on its `.ext-slot` as
  `data-chip`) and it may carry a `label` (fallback: its id). `api.cards`
  (`chips()`, `hideChips(keys)`, `renderSample(el, { hidden })`) is gated on
  **`cards:hideChips`, the first CLIENT-ONLY capability**: it rides `requires`
  (and the connect announcement, for `handlerTypes`' fail-closed reason) and is
  disclosed in the consent dialog, but lives in `CLIENT_CAPABILITIES`, disjoint
  from `CAPABILITIES`, and `buildHostApi` skips it — there is no façade key. The
  `cards` key is always on the client api; every call THROWS without the grant.
  The board hides the **union** of every extension's `hideChips` set; a
  `removeExtension` (disable, uninstall, failed load) clears that extension's
  set and redraws, so its chips come back. A hidden core chip is still rendered
  with `hidden` (`ctx.hiddenChips`); a hidden pill is simply not mounted in that
  host (torn down if it was) but stays registered. The detail panel and task
  tiles share the builders and carry `data-chip` too, but never apply the veto —
  keep the `[hidden]` CSS scoped to `.card-meta`.
- **Sample cards are reconciled with the board's in ONE `syncHosts` call.**
  `renderSample` draws an inert `sessionCardHtml(SAMPLE_SESSION)`
  (`public/sample-session.js`, every core chip populated, `sessionId:
  '__sample__'`, `sample: true`) and registers its `.card-meta-ext` in
  `app.js`'s `sampleHosts`, which `mountCardPills` appends to the board's
  entries with that preview's own `hidden` set and `sample: true`. Reconciled
  separately, each render would tear down the other's pills (`syncHosts` is
  set-semantics over the whole slot). A pill that throws on a sample host is
  reported once and skipped THERE only — never dropped from the board. **Pill
  authors:** `session.sample === true` means a preview; render placeholder
  content or nothing (a picker may then label it "not in preview").
- **A `dispatch.field` contribution's `ext(el, ctx)` is data for its OWN server
  half, and the namespace is FORCED.** `dispatchFields` puts it at
  `payload.ext[<extId>]` (a `fields()` writing `ext` whole is refused and
  reported, or it could overwrite a sibling's slice); `runDispatch` →
  `sessionManager.dispatch` → the `onBeforeDispatch` payload carries the whole
  bag, and `hookPayloadFor` (extensions/index.js, applied by `index.js`'s hook
  binding) narrows it to that extension's slice — `null` when it sent nothing.
  An extension runtime's `preflight` and `buildLaunch` get the same narrowed
  slice. A scheduled dispatch stores the payload whole, so the bag fires with it.
- **`host.sessions.spawn({ taskId })` hands the task to dispatch BEFORE the pane
  starts, and `tasks.assign` after the spawn is NOT the same thing.** The option
  becomes dispatch's `taskId`, which is what `session.launchContext` hooks see
  (task-memory points the session's `by-session` symlink at the task folder in
  that window); assigning afterwards repoints the
  same link, which a running **Claude** follows and a running **Codex** does
  not — Codex resolves its writable roots once, at launch, so a late repoint
  leaves it writing into the session's own scratch memory while the board says
  it is on the task. The builder therefore does BOTH halves (pass the task pre-launch,
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
- **`host.sessions.spawn({ ext })` (1.48.0)** forwards a whole dispatch data bag,
  a plain object keyed by extension id whose slices are plain objects or `null`;
  malformed data is refused by name (`ext` or `ext.<id>`) before dispatch.
  The same narrowing reaches `session.prepare`, `onBeforeDispatch` and runtime
  `preflight`/`buildLaunch`, while `spawnedBy` remains core-managed and unpassable.
- **`host.terminals.create({ cwd, command?, presentation?, title?, key? })`
  (`terminals:create`)** opens a plain shell with `command` typed but not run,
  and resolves `{ terminalId, reused }`. The default presentation is a sidebar
  pane in every board tab, closed (and killed) with its pane. `presentation:
  'dialog'` (1.50.0) opens it, headed by `title`, only in the tab whose control
  message the calling handler is serving, over anything open there such as
  Settings; called from a sweep, hook or tool, or after that tab has gone, the
  shell starts but nothing is shown. Closing the dialog detaches: the shell keeps
  running until it exits, and focus returns to where it was. A dialog requires
  a `key`, and a create whose `key` matches a live shell this extension opened
  presents that shell again without retyping the command, so the same call
  doubles as Reopen. `host.terminals.alive(terminalId)` (1.50.0) says whether
  one of this extension's own terminals is still running, for showing Reopen.
  The key is namespaced to the calling extension, and the tab is read from the
  handler's async context, never from an argument. Shell exit is never a success
  signal; the extension reports its own state.
- **`host.sessions.launchEnv({ agent = 'claude', sessionId = null, ext = null })`
  (1.48.0, `sessions:env`)** returns `{ env }` from the enabled launch-context hooks
  with `reason: 'headless'`, resolving the task and runtime for a supplied card or
  using the supplied `ext` bag for a run with no card.
  `agent` must be `claude` or `codex`, `sessionId` a string or `null`, and a non-null
  `ext` follows spawn's validation; a deliberate refusal rejects with its reason,
  so the caller must skip the run rather than fall back to another environment.
  This capability permits reading the merged environment for any card, including
  credentials contributed by other extensions; it is not restricted to cards the
  caller created. Keep the returned environment in the subprocess only: never
  expose it in logs, graph data, settings or other persisted launch metadata.
- **`host.sessions.spawn({ offBoard: true })` keeps the card off the board** (1.41.0).
  The entry is stamped with the CALLING extension's id (forced, never
  caller-named) and the stamp survives resume. The card stays in the graph with
  `offBoard: '<extId>'`, and `sessions:read` reports the same field, so the
  extension can show and drive it in its own view; the board's grid, task tiles,
  minimised-task dots, keyboard nav and Attach picker filter it out
  (`public/off-board.js`). Nothing else changes: it resumes, archives
  (`sessions.archive`, or the task's Archive) and bills exactly as a board card
  does. A manifest using it declares `^1.41.0`.
- **`host.sessions.spawn({ remoteControl: { name } })` turns on Claude Code
  Remote Control for that one session** (1.55.0). The launch passes
  `--remote-control <name>`, and the name is stored on the entry so every resume
  (idle-suspend wake, mail wake, a relaunch after an update) passes it again. A
  fork does not inherit it. Only agents explicitly opting into the adapter's
  Remote Control capability are accepted; currently that is Claude. The default
  target is Claude. Unsupported or unknown agents are refused by name before
  dispatch creates a directory, worktree, card or session. An unknown key or a
  `name` that is empty, contains control characters or starts with `-` is also
  refused; accepted names are trimmed. Omission leaves Remote Control off.
  The core [`spawn_session` MCP tool](agent-tools.md#remote-control-on-spawn_session)
  also exposes it as `remote_control: "Phone"`. The board dialog, workflows,
  scheduling and handoff do not offer it. A manifest using the host option
  declares `^1.55.0`.
- **`adversarial-review`'s shape is a SKILL plus a
  TOOL on purpose.** A SKILL.md is static, so it cannot carry the human's
  configured process; Claude's `` !`cmd` `` injection would, but Codex reads
  SKILL.md as a plain file, and the reviewer is usually Codex. MCP tools are the
  one channel both providers fully support. Measured on 2026-09-30 (3 Claude +
  3 Codex runs per condition): a stub skill naming a tool was followed 6/6, the
  same as a static skill, while the tool alone with a skill-style description
  was called 0/6. So the skill stays the discoverable entry point and names
  `adversarial_review_process` in the reviewer's brief; never rely on a tool's
  description for discovery. The tool returns the `process` setting when it is
  non-blank (else `default-process.md`) followed by `report-contract.md`, which
  is NOT configurable: the initiator, and any fix/re-review loop around it,
  waits on exactly one mail in that shape. There is still no `default` on a
  def; the setting's `placeholder` is the default text, so an empty field shows
  what will run. A generic `read_skill` for any extension is deferred until a
  second skill needs settings-rendered content.

## Launch context, events and lifecycle

- **`hooks['session.launchContext']`**, called with `{ sid, task, agent, runtime,
  reason, parentId?, ext, host }`, returns `{ env?, addDirs?, codexConfig?, refuse?, refuseIfSet? }` (or a Promise of it). `server/launch-context.js`
  `collectLaunchContext` asks every ENABLED extension, merges `env` (later wins,
  collisions logged; names must be `UPPER_SNAKE`, and core's own variables are
  written after, so an extension can never override `AW_SESSION_ID`) and
  `addDirs` (absolute, deduped), and logs and skips a hook that throws or
  answers nonsense. Dispatch, resume and fork await it before building the
  command; the Claude and Codex adapters and the devcontainer runtime (which
  copies each granted dir into the container) read the result through the same
  helpers. `reason` is one of `dispatch | resume | fork | message | snooze-wake |
  spawn | assign | adopt | headless`; `assign` (a running session moved to another task) and
  `adopt` (server boot) are not launches: the hook still runs and the result is
  discarded. Turning an extension on or off applies to new launches; running
  sessions keep their env until relaunched. `parentId` (1.47.0) is the parent
  card id on fork, before the child's inherited state is saved; dispatch awaits
  `onBeforeDispatch` before collecting launch context so hooks can read its bindings.
  A non-empty string `refuse` (1.47.0) fails the launch with that reason immediately,
  without asking later hooks or caching a partial context.
  `refuseIfSet` (1.51.0) lists `UPPER_SNAKE` variable names that the pane checks
  under `/bin/sh` after the user's shell has started (so tmux's global
  environment and shell startup files count), before the agent runs: if any is
  set, even to an empty string, the launch exits naming it, and its value is
  never read. A runtime that builds its own launch cannot run the check, so
  a dispatch, resume or fork on it is refused instead. Names merge across extensions; headless runs build their
  environment in the server, where `refuse` already sees it. When the merged
  `env` sets `CLAUDE_CONFIG_DIR` (1.51.0), a Claude dispatch, resume or fork also writes
  the default launch's folder trust into that directory's `.claude.json`: the
  sessions directory, a worktree whose repo the server's own Claude config
  trusts, and the launch folder when that config already trusts it. Only the
  server's config authorises a folder. The directory must already exist and
  must not be the server's or the CLI's default config directory, and a
  symlinked `.claude.json` is left alone.
  `codexConfig` (1.54.0) is `{ 'dotted.key': value }`, passed to a Codex
  dispatch, resume and fork as `-c key=value`; Claude launches ignore it. It
  merges across extensions like `env` (later wins, collisions logged) and is
  absent from the result when empty. Keys are
  bare dotted segments (`[A-Za-z0-9_-]`); values are strings (no control
  characters, at most 1024 characters), finite numbers or booleans, and core
  writes the TOML. Dropped, each with a logged error naming the key and the
  reason but never the value: keys core or `codexPolicy` own, matched on the
  first segment (`model`, `model_reasoning_effort`,
  `model_auto_compact_token_limit`, `developer_instructions`, `notify`,
  `mcp_servers`, `sandbox_mode`, `approval_policy`, `sandbox_workspace_write`,
  `projects`, `profile`, `profiles`), so they cannot be overridden whatever the
  `-c` order; credential-shaped keys (a segment such as `token`, `api_key`,
  `secret`, `password`, `bearer`, `headers`, `env`, or
  `shell_environment_policy.set.*`); and credential-shaped values
  (`sk-`, `ghp_`, a JWT, `Bearer …`). This is not a credential API: overrides are
  visible in argv, `ps` and the tmux pane, so pass only nonsecret settings such
  as `cli_auth_credentials_store = "keyring"`. A runtime that builds its own
  launch gets none of the context, this field included.
  `ext` (1.48.0) is this extension's narrowed dispatch-data slice or `null`, for
  every reason, including `headless` runs on behalf of a card or stored launch.
  Headless requests must leave the card's live session bindings unchanged; hooks
  should only resolve the requested environment, and core does not cache their
  directory grants. Task memory contributes nothing to a headless run.
  Core's `runHeadlessClaude` merges an `env` option over the process environment,
  then strips nested-Claude markers, preserving an explicitly supplied
  `CLAUDE_CODE_OAUTH_TOKEN` for the selected login;
  archive memory review collects the card's headless context before running and logs
  a refusal as a skipped review, without stamping or publishing a result.
- **`hooks['session.prepare']`** (1.32.0), called with `{ sessionId, taskId,
  cwd, repoRoot, willCreateWorktree, agent, spawnedBy, ext, runtime, ownLaunch, host }`, returns `void | { abort?:
  string, warnings?: string[] }` (or a Promise). It runs for a NEW dispatch
  (manual, scheduled, `spawn_session`) after the cwd is resolved and BEFORE the
  worktree is created, so a hook can bring the repo up to date (`git pull
  --ff-only`) and the worktree then branches from it. `repoRoot` is `git
  rev-parse --show-toplevel` of `cwd`, or `null` outside a repository. Since 1.47.0,
  `spawnedBy` is the spawning card id or `null`, and `ext` is this extension's own
  dispatch-field slice or `null`. `runtime` is the resolved runtime id (`local`
  by default), and `ownLaunch` says whether it builds its own command. Enabled
  extensions are awaited in order. `abort` fails the dispatch with that message
  through the usual dispatch error path, with no worktree or pane created
  (later extensions are not asked); `warnings` toast on the board and the
  launch goes ahead. A hook that throws or takes over 60s is logged and
  skipped. Resume and fork never fire it. `server/session-prepare.js`.
- **`host.events`** (capability `events`, 1.17.0): `on(name, fn)` and `emit(name, payload)`.
  Subscriber errors are caught and logged per handler, `emit` does not wait, and
  an extension's subscriptions are dropped when it deactivates, so a disabled
  extension hears nothing. `emit` publishes `ext:<id>:<name>` (forced), so an
  extension cannot forge a core event. Core event: `archive-review:completed
  { sid, taskId, markdown }` (the review is skipped when nobody listens).
- **`activate({ host })` / `deactivate({ host })`** (1.17.0) manifest functions run when the
  extension turns on or off; a throwing `activate` quarantines it.
- **`host.memory.*`** (1.17.0) is provided by the task-memory extension. While it is off,
  `read` returns `null`, `has` and `append` return `false`, with a logged warning.
- **`links.normalise({ link, host })`** (manifest `hooks`, 1.18.0) is how an extension
  claims a board link type; core keeps only `pr`. `set_links` offers each link to
  every enabled extension's hook in turn: return the stored link to claim it,
  `undefined` for a type that is not yours, or throw to reject an invalid one. The
  hook is synchronous. A link no hook claims is rejected, except one already
  stored on that task or session: those pass through unchanged, so an agent
  resending the full list from `get_links` is not broken by an extension being off.
  `remove_links` matches non-`pr` links generically (key, case-insensitive, or url).
- **`host.links`** (capability `links:write`, 1.19.0) lets server code put a link
  on a card when no agent will call `set_links` for it, e.g. a sweep that learns a
  URL after launch. `get(sid)` returns a copy of the card's session links (`[]` for
  an unknown card). `attach(sid, link)` is synchronous: it runs the link through
  the CALLING extension's own `links.normalise` hook only, so an extension can
  store only a type it claims (never `pr` or a sibling's), and throws when that
  hook answers `undefined` or throws, or when the card does not exist (an unknown
  id is never adopted, unlike `set_links`). An existing link matching by
  `linkMatches` is replaced in place, otherwise it is appended; the board rebuilds.
- **Images in a first prompt** (1.31.0). `api.images.stage(file)` (client, takes a
  `File`/`Blob`, rejects a non-image) uploads through the same `paste-image`
  `staged` path as the dispatch dialog's intent box (magic-byte sniff, mime
  allowlist, 10 MB cap) and resolves `{ name }`, a server-minted name, never a
  path; `api.openDispatch({ images })` (1.36.0) attaches such names in the dispatch
  dialog for the human to launch. `host.sessions.spawn({ images: [name, ...] })`
  (at most 8) launches with the prompt held back and then pastes each image ahead of the prompt text once
  the TUI has booted, as `runDispatch` does; a name that is not a minted name, or
  is neither staged nor kept, throws before anything launches. Staged names are
  single-use (the session takes the file) and pruned after a week, so work that
  seeds several sessions with the same images keeps its own copies: capability
  **`images:keep`** gives `host.images.keep(name)` (copies a staged image into
  the extension's own store, `false` if it is not staged), `read(name)` →
  `{ mime, bytes }` or `null` (to show it back), and `remove(name)`. `spawn`
  resolves a name in the extension's kept store first and COPIES from it, so the
  same name can go into any number of spawns. Kept images are never pruned; the
  extension removes them. Images need a local launch. A manifest using any of
  these declares `^1.31.0`.
- **Opening local files** (1.38.0). Capability **`files:view`**, listed with the other
  capabilities when the extension is installed, lets an extension show the local files its
  data points at. Server side, `host.files.allow(pathOrPaths)` registers paths (absolute,
  already normalised, of a viewable type) and returns how many it accepted;
  `host.files.forget(pathOrPaths)` drops them. The set is per extension, in memory, and
  capped (oldest dropped first), so an extension re-registers what it reports. Client side,
  `api.openFile(path)` opens the viewer panel and resolves `{ ok: true }` or
  `{ ok: false, reason }`; it never rejects. `api.files.canOpen(path)` and `api.files.types()`
  (`[{ ext, kind, mime }]`) are synchronous and decide by extension alone, with no disk
  access. `api.files` is undefined on a board older than 1.38.0 and when the manifest does not
  require `files:view`, so guard with `api.files?.canOpen(path)` and fall back to Copy only.
  Viewable today: markdown (`.md`, `.markdown`, rendered) and images (`.png`, `.jpg`,
  `.jpeg`, `.gif`, `.webp`). One table maps extension to kind and mime (`public/file-types.js`);
  the mime is derived, never sniffed. A read needs the path to be registered by that
  extension, and the file to be a regular file opened without following symlinks, whose path
  still resolves to itself, under 2 MB (markdown) or 8 MB (images). `reason` is one of
  `invalid-path`, `unsupported-type`, `not-permitted` (not registered, or no capability),
  `not-found`, `changed` (a symlink now sits in the path), `not-a-file`, `too-large`,
  `unavailable` (not connected) or `error`. A manifest using it declares `^1.38.0`.
- **Opening file links: the `file.open` client slot** (1.40.0). Capability **`files:open`**
  (browser-only, disclosed at install) lets an extension take the file links a human clicks in
  a session's chat or terminal, instead of the board's preview. It is a value slot:
  `open(file, graph, api)` with `file` = `{ path, sessionId, source }`, where `path` is the
  resolved absolute path, `sessionId` the session it was clicked in and `source` `'chat'` or
  `'terminal'`. Returning `true` takes it; anything else leaves it to the next contribution,
  in extension load order, and then to the board's preview. A throwing `open` is reported and
  removed, and the link falls through. Registering without `files:open` throws. Only the links
  core makes today reach it (`.md` and `.markdown` paths). `api.openFile` is unaffected. A
  manifest using it declares `^1.40.0`.
- **Locking a session's input: the `session.inputGate` client slot** (1.52.0). A value slot,
  `{ id, gate(session, graph, api) }`: return `{ reason, label? }` to lock the session or `null`
  to leave it alone. While locked, typed input to the session's terminal (and to a sidebar
  shell opened for it) is dropped, while mouse and focus reports still pass, so the wheel
  scrolls, clicks land, and selecting and copying work. The chat composer is disabled, with
  `reason` as its placeholder, and the first blocked keystroke of each lock shows a toast with
  `reason`. Both strings are text. The first contribution that answers wins, in extension load
  order. A `working` session is never asked and never locked. Gates are re-run on every graph
  and when the extension calls `api.refreshInputGates()`, so a gate that depends on the clock
  needs only a timer, and an unlock control calls it after changing its own state. A throwing
  `gate` is reported and removed, and disabling the extension unlocks at once. Core draws
  nothing on the card: show the lock with a `card.pill`. A raw `tmux attach` is not gated. A
  manifest using it declares `^1.52.0`.
- **Client `api.mountSession(el, sessionId, { onMaximize })`** (1.42.0) shows the board's own
  session panel inside the extension's element: the header and its controls (rename, Actions,
  the session's chips), the `panel.section` strips, Chat, Terminal, and the diff as a third
  **Diff** view in place of the panel over the grid. It is the same panel the board uses, moved
  rather than copied, so one element holds it at a time. A dormant session is resumed and one
  that is not on the board (archived) is restored first, showing "Restoring…" until it is back;
  either way the selection stays in the extension's view. It returns a handle, or `null` when
  `el` is not an element or `sessionId` not an id (reported, like a refused `openSession`):
  `show(id)` swaps the session shown (mounting the same element again does too), `unmount()`
  gives the panel back to the board (call it when the element goes), and `sessionId` reads
  `null` once it has. A mount into another element takes the panel over and the older handle
  goes inert. While the element's view is not on screen the panel is home and the board uses it
  as usual, and it returns when the view does; an element dropped from the document without
  `unmount()` is reclaimed on the next graph tick, so the board never loses its panel. The
  element sets the size and the panel fills it. Embedded, the header has no Close (leaving is the
  extension's) and shows Fullscreen only when `onMaximize(on)` is given, which is called with
  the new state on each click so the extension can give the element more room. A manifest using
  it declares `^1.42.0`.
- **`view: 'diff'` on `api.mountSession`** (1.45.0): `mountSession(el, sessionId, { view: 'diff' })`
  and `handle.show(id, { view: 'diff' })` open the panel on that session's **Diff** instead of
  Chat or Terminal, for a "review this" button that should land on the changes. It applies to
  that one show: the view coming back on screen later reopens wherever the human left it. Any
  other `view` is reported and ignored. An older board ignores the option and opens on Chat or
  Terminal as before, so a manifest that needs it declares `^1.45.0`; one that only prefers it
  can keep its range and let older boards open as they always have.
- **Manifest `themes`** (1.43.0) contributes themes to the Settings theme picker. The loader
  validates that the path resolves inside the manifest's `dir` and stages `{ id, dir }` on
  `themeDirs` for an ENABLED extension only, kept in list order so a re-enable does not change
  which extension wins an id tie. `server/styles.js` `listStyles`/`assetPath` read it with the
  precedence in [Themes](#themes), so a theme's assets always come from the source that won its
  id. A toggle's rebuild re-broadcasts the `styles` frame. The client's `setCustomStyles` then
  shows Dark for a saved theme that has gone, without writing `cm-style`, and redraws the
  picker's rows if Settings is open. An older server ignores the key, so a manifest using it
  declares `^1.43.0`.
- **Setting def `theme`** (1.46.0) is legal only on a `toggle`, only on a manifest
  with `themes`, and names each theme id once (`validateManifest`). The loader
  stages `{ themeId: settingKey }` as the `themeDirs` entry's `toggles`, and
  `themeSources(themeDirs)` adds `off` from the extension's setting values at call
  time. `server/index.js` passes it to the `styles` broadcast and, as
  `extensionThemes`, to `/api/styles` and the asset route, so an
  `ext-setting-set` rebuild re-broadcasts the theme list with no re-staging.
  `server/styles.js` skips an `off` id in that source, so a lower source can
  answer it. An older server ignores the field, so a manifest relying on it
  declares `^1.46.0`.
- **Client `api.themeButtonHtml(style, { active })`** (1.44.0) returns `public/theme.js`
  `themeButtonHtml` (app.js injects it into `createSlots`), the markup Settings › Appearance draws per theme: `aria-pressed` and the
  `active` class follow `active`, colours are read from the entry's `vars` or a raw `theme.json`'s
  `colors` (falling back to its `base`'s Dark or Light values) and only plain hex, `rgb[a]()` or `hsl[a]()` values reach the
  inline style. The board's stylesheet styles `.theme-row`, so the extension adds no CSS. A
  manifest using it declares `^1.44.0`.
- **`link.chip` client slot** (1.18.0) is a value slot: `chip(link, graph, api)` returns
  `{ label, href?, icon? }` for the extension's own link type and `null` otherwise.
  Core draws the markup, so `label` and `href` stay text (`href` must be http(s)) and
  `icon` is accepted only as a single `<svg>` of `<path>`s with plain attributes.
  A link no contribution answers for draws no chip, on cards, task tiles and the
  panel alike. Read the extension's own settings with `api.settings()`, as the Jira
  chip does to link a key-only link against the current base URL.
- **Client `api.ui.markdownPreview(md)`** returns sanitised HTML from the shared
  markdown renderer (`public/markdown-preview.js`).
- **Client `api.ui.notify({ id, title, body, actions })`** (1.23.0) raises a card in
  the board's bottom-right notification stack for something the human did not ask
  about. Cards stack, stay until answered or closed, and never take focus. It
  resolves with the clicked action's `id` (`actions` is up to three
  `{ id, label, primary? }`), or `null` when the card is closed with × or
  withdrawn. Showing an `id` that is already up updates it in place.
  `api.ui.withdraw(id)` takes one down. Ids are per extension, and an extension's
  cards are removed when it is turned off. All text is set as text.
- **`host.tasks.archive(taskId)`** (capability `tasks:archive`, 1.23.0) archives a
  task as its tile's Archive does: the task and every live session assigned to it.
  Resolves `{ archived, sessionIds, unclean }`; `archived` is false for an unknown or
  already-archived task. It is separate from `tasks:write` so a consent to rename
  and assign never grows into one that stops sessions.

## Runtimes

A runtime is where a session's agent runs. The built-ins are `local` (the host) and
`devcontainer`; an extension adds one with a `runtimes` array on its manifest (1.19.0),
and no capability is needed to do so. It appears in the dispatch dialog's **Runtime**
select while the extension is enabled, and `spawn_session` accepts its id as `runtime`.

```js
runtimes: [{
  id: 'toyrt',                 // ID_RE; may not collide with a built-in or another extension
  label: 'Toy',                // shown in the Runtime select and in refusals
  // agents: ['claude', 'codex'], // 1.37.0; the agents it runs, default ['claude']
  wrapLaunch: async ({ inner }) => `echo hi && ${inner}`,
  // preflight: async ({ cwd, agent, workflow, worktree, ext }) => 'refusal' | null,
}],
```

Each entry needs exactly one of `wrapLaunch({ inner, cwd, sessionId, parentId, worktree,
workflow, launchContext })` (decorate the agent's command; `parentId`, 1.29.0, is the
parent card's id and is passed on fork only) or `buildLaunch({ phase, intent, cwd,
sessionId, model, ext })` (return the whole pane command instead). Optional:
`preflight` (return a string to refuse the dispatch before anything is created),
`readLive({ entry, tmuxName, socket })`, `analyze({ entry, liveSid })`,
`deliver({ entry, from, text })` (return `{ ok: true }` or `{ ok: false, error }`),
`launchStatus({ entry })` (1.22.0; return `{ state, error?, url? }` or null),
`cost({ entry, liveSid })` (1.29.0; return `{ usd }` or null),
`validateModel({ agent, model, coreModelError })` (1.30.0; return an error string or null —
define it and the runtime owns its sessions' model vocabulary: `spawn_session` skips core's
per-agent check, asks this instead, and passes the accepted model as `ext.<yourId>.model`;
`coreModelError(agent, model)` is core's own check, to reuse),
`resumable` (default `true`), `skipsHostResumeGuard` and `liveByTmux` (1.34.0, default
`false`; see below), and `agents` (1.37.0; the agent ids it runs, default `['claude']`:
dispatch and `spawn_session` refuse any other agent, and the dialog disables the option
for one). Every function is also handed
`host` (the extension's façade) and `settings` (its own setting values), and `ext` is
narrowed to the extension's own dispatch-field data.

Maintainer notes:

- **The contract is symmetric with the built-ins** (`server/runtimes/index.js`), so
  devcontainer can later move out unchanged. The registry module must not import
  `server/extensions/**` (`runtimes/devcontainer → agents/claude → agent-skills →
  extensions` would cycle), so `server/index.js` passes `BUILTIN_RUNTIME_IDS` to the
  loader as `coreRuntimeIds` and fills the registry itself.
- **Collisions quarantine, first-come.** `reg.runtimeIds` is seeded with the built-in
  ids, so `local` is never claimable and of two externals naming one runtime the later
  is quarantined. A within-manifest duplicate, a missing or doubled launch function, a
  non-function hook or a non-boolean flag quarantine too. A disabled extension claims
  no id; unregister releases them.
- **Bound like session hooks.** `activateExtension` registers a copy of each runtime
  whose functions call `fn({ ...hookPayloadFor(extId, args), host, settings })` and
  re-check `hostApis.has(extId)` per call, so it is inert whichever of deactivate and
  the registry runs first: `preflight` refuses, `wrapLaunch`/`buildLaunch`/`deliver`
  throw "extension <id> is not active", `readLive`/`analyze`/`cost`/`launchStatus` return null.
  `deactivateExtension` calls `unregisterRuntimesFor`, so enable and disable are live.
- **`cost` replaces only `usd`.** For a runtime that prices requests itself (e.g. a
  gateway). `state-reader.applyRuntimeCost` runs after `analyze`/transcript costing on
  every graph tick, for live and dormant cards, so cache per tick. A finite,
  non-negative `usd` becomes the card's total; tokens, sub-agents, advisor spend and
  activity still come from the transcript (the sub-agent and advisor figures are
  breakdowns, never added to `usd`). null, a throw or an off-shape answer keeps the
  transcript figure. The cost chip, `get_session_cost` and anything reading graph `usd`
  see the override; `host.usage.byCard()` and the `cost-report` skill recompute from
  transcripts and do not.
- **`ownLaunch` (1.47.0)** on the runtimes announcement and `graph.extensions[].runtimes`
  is `true` for `buildLaunch` and `false` for `wrapLaunch`; the client exposes it
  through `api.runtimes()` so dispatch fields can validate runtime combinations.
- **`buildLaunch` ⇒ `resumable: false`** in 1.19.0 (validation quarantines otherwise).
  It is called at dispatch only (`phase: 'dispatch'`; other phases are reserved), and
  that path skips the preset live id, the adapter's command, `wrapLaunch` and live-id
  resolution, storing no `liveSessionId`. The skill gate, codex policy and launch
  context still run, unused. `noteLiveSessionId` never adopts a conversation id for a
  `resumable: false` runtime, so a local client's own id can't take over the card.
- **Refusals by name.** Dispatch stamps `entry.runtimeExt`, so after the extension is
  gone `relaunchRefusal` can still say `This session runs on runtime "<id>", which needs
  the "<ext>" extension. Enable it in Settings → Extensions.` A `resumable: false`
  runtime refuses with `"<label>" sessions can't be resumed or forked`. Resume checks
  BEFORE `killForSession`, so a refused resume never kills a held pane; every implicit
  resume (`host.sessions.wake`, `host.deliver`, PR nudges, schedules, snooze wakes)
  surfaces the throw as its own error.
- **The graph tick never throws on a missing runtime**: `buildGraph`'s default resolver
  is `findRuntime`, falling back to local for status and cost. A `buildLaunch` card
  whose tmux is alive is kept live by tmux liveness, like a devcontainer bring-up,
  because its pane never runs a `claude` that discovery would match.
- **`agents` (1.37.0) is enforced at dispatch.** `runtimeAgentError` runs before
  preflight in `session-manager.js`, and `spawn_session` checks it up front, so a stale
  dialog selection, a schedule or a script can't put an unlisted agent on the runtime.
  `local` takes every agent; devcontainer is Claude-only, since its status and cost
  hooks read Claude paths. The loader checks shape only (a non-empty array of distinct
  strings), because it can't import the adapters. An older server ignores the key and
  keeps the runtime Claude-only, so a manifest that needs it declares `^1.37.0`.
- **`liveByTmux: true` (1.34.0) opts a `wrapLaunch` runtime into that same fallback.**
  Use it when the pane runs a wrapper that hides the agent from process discovery, such
  as `sbx exec -it <sandbox> sh -lc '<agent>'`: without it the card reads as dormant
  while it runs and offers a Resume. Discovery and costing are otherwise unchanged, so
  the agent's transcript must still land on the host. An older server ignores the key,
  so a manifest that needs it declares `^1.34.0`.
- **`deliver` sits on send_message's legacy push path**, before the tmux check, and gets
  the BEGIN/END-fenced text, because the target is a raw prompt stream. The footer drops
  the "reply with send_message" line, since that agent has no wrangler MCP. A card whose
  runtime has `buildLaunch` or `deliver` is stored `mailCapable: false` (its command has
  no `--mcp-config`, so no `read_mail`); that flag is what routes peer messages there.
  `mailbox-delivery.js` is untouched, since a mailbox branch for such a card could never
  run.
- **`launchStatus` is for launches that fail after dispatch returns** (1.22.0), such as
  a hand-off to a remote service. `state` is `pending`, `ok`, `failed` (with `error`)
  or `unknown`. `spawn_session` polls it every 250 ms for up to 15 s
  (`runtimes/launch-status.js`), returns it as `launch`, and turns `failed` into an
  error result that still carries the new `sessionId`; `wait: false` skips the wait.
  `list_sessions` adds `launch` to each row whose runtime answers. An off-shape answer
  or a throw reads as no answer, and the bound copy returns null while inactive. Keep
  it cheap: it runs once per row on every `list_sessions`.
- **Follow-up extraction.** Devcontainer is still special-cased outside the contract:
  the archive stop-container offer and its cascade (`control/handlers/archive.js`,
  `public/archive-cascade.js`), `archive-session`'s `stop_container`, the add-dirs resync in
  `session-manager.js`, the dormant-container sweep in `state-reader.js` and the card
  chip (`public/cards.js`, `app.js`). Moving devcontainer into an extension means
  turning each of these into a contract field.

## Builtin: task-memory

`server/extensions/builtin/task-memory/` (default on) owns the memory store and
watcher (started in `activate`), the `AW_TASK_MEMORY` env and `--add-dir` grant
(Claude gets the stable symlink, Codex the resolved path), the `task-memory`
skill, the `get-memory`/`set-memory` handlers, the task `hasMemory` graph dot,
and the modal and task-menu items. Disabling it in Settings > Extensions removes
all of that; notes stay on disk under `~/.agent-wrangler/memory`. The old
`taskMemoryEnabled: false` config value is migrated to
`extensions.task-memory = false` at boot.

## Builtin: jira

`server/extensions/builtin/jira/` (default on) owns the `jira` link type
(`links.normalise` hook: a key and/or url, with the url built from the **Jira base
URL** setting when only a key is given) and the chip (`link.chip` contribution). The
setting falls back to `AW_JIRA_BASE_URL` while empty and gains a trailing slash if
it lacks one. At boot the old `jiraBaseUrl` config value, or failing that
`AW_JIRA_BASE_URL`, is copied into `extensionSettings.jira.baseUrl` when none is set
(`RETIRED_SETTINGS` in `config-store.js`). Disabling it keeps stored Jira links and
hides their chips.

## Builtin: themes

`server/extensions/builtin/themes/` (default on) ships the bundled themes beyond
Dark and Light as its manifest `themes` (`themes/<id>/`), under the ids a browser
already saves in `cm-style`. Each theme folder gets a hidden `toggle` named for it
in camelCase (`pixel-cats` → `pixelCats`) with `theme` set, so adding a folder adds
its switch. The `themes-list` handler replies with every theme's `theme.json`, the
switched-off ones included, for the `settings.panel` to draw with
`api.themeButtonHtml`: pressed is on, a click calls `api.settings.set`. Core never
rewrites `cm-style` for a theme that has gone, so a browser shows Dark until it
returns. The client also raises a one-time `api.ui.notify` card for a browser
whose saved theme is `jurassic-park` while nothing offers it, linking the
community extension that theme moved to.
