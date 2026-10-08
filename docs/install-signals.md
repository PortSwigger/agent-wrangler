# Install signals

Environment variables that describe how an install was packaged and started. They decide what the
board's updater and Restart button may do. A start script, service definition or package wrapper
sets them; you don't normally set them by hand. This page is the contract for anyone packaging
Agent Wrangler, for example a Homebrew formula.

## Signals

| Variable | Value | Default | Set by | Effect |
| --- | --- | --- | --- | --- |
| `AW_SUPERVISED` | `1` | unset | `scripts/wrangler-start.sh` (launchd plist, systemd unit), a Homebrew service | Something restarts the process when it exits. Enables the board's **Restart the wrangler** button, except in a dev instance (`AW_DEV`), and trims service logs at startup. It does **not** allow Git updates. |
| `AW_GIT_UPDATES` | `1` | unset | `scripts/wrangler-start.sh` only | The start path rolls back an update that fails to start (`update-rollback.sh`) and installs changed dependencies (`sync-deps.sh`) before the launcher runs. Required, together with `AW_SUPERVISED=1`, before **Update and restart** or **Auto** can apply a Git update. |
| `AW_INSTALL_MANAGER` | a package manager's name, e.g. `homebrew` | unset | a package wrapper (the Homebrew formula) | A package manager owns the install. The board's Git updater is disabled: no checks, no applies, and Settings › Updates says how to update instead (`brew upgrade agent-wrangler` for `homebrew`). The app reports its package version. Restart stays available when `AW_SUPERVISED=1`. |
| `AW_NODE` | path to `node` | `node` on `PATH` | a package wrapper | The interpreter the launcher execs. Use a path that stays stable across upgrades, such as Homebrew's `opt/node/bin/node`. |
| `AW_INSTALL_ROOT` | absolute directory path | the real app directory | a package wrapper | An upgrade-stable path to the app, such as a symlink that an upgrade repoints. Every path a session is handed at launch is built from it (see [Session paths](#session-paths)) when it resolves to the running app, as is the `node_modules/.bin` entry the launcher adds to `PATH`. If an upgrade repoints it while the server runs, Settings › Updates asks for a restart. Ignored by a dev instance (`AW_DEV`). Git never runs here; it always runs in the real app directory. |
| `AW_LOGS_TRIMMED` | `1` | unset | the launcher, internally | Stops a second log trim when `wrangler-start.sh` hands off to `bin/agent-wrangler`. Not a setting. |

Only exactly `1` turns `AW_SUPERVISED` or `AW_GIT_UPDATES` on. Any non-blank `AW_INSTALL_MANAGER`
marks the install as managed.

## What the updater does

Settings › Updates and the hourly check use the first row that matches:

| Install | Checks | Applies |
| --- | --- | --- |
| `AW_INSTALL_MANAGER` set | never; shown as unavailable | never |
| The app directory is not the top level of a Git work tree (an unpacked release, or a Homebrew keg inside Homebrew's own repository) | never; shown as unavailable | never |
| A checkout started by `scripts/wrangler-start.sh` under launchd or systemd | yes | yes |
| Any other checkout (`npm start`, a bare `bin/agent-wrangler`, a dev instance with `AW_DEV`) | yes | no: pull and restart by hand |

An ordinary checkout and a linked worktree both count as checkouts. A checkout reached through a
symlink is resolved to its real directory first. Git can't walk up out of the app directory, and
inherited `GIT_DIR`, `GIT_WORK_TREE` and similar overrides are ignored. An enclosing repository is
therefore never fetched, read or merged.

When updates are unavailable, a `Notify` or `Auto` value left in `config.json` is ignored, nothing is
logged on each interval, and Settings › Updates hides the **Automatic updates** row.

## Session paths

A session is handed absolute paths into the app when it launches, and reads them for as long as
it runs. Node resolves the app's real directory. If an install keeps each version in its own
directory and an upgrade removes the old one, that directory disappears under any session still
running, so the PR-attach hook would fail and the skills would vanish.

With `AW_INSTALL_ROOT` set, these paths are built from it instead (`server/install-root.js`):

- the PostToolUse PR-attach hook, `scripts/pr-attach-hook.mjs`, and its `server/pr-hook.js`
- the wrangler-meta skills plugin, `agent-skills` (Claude's `--plugin-dir`, and the `SKILL.md`
  paths in Codex's instructions)
- each builtin extension's skills, `server/extensions/builtin/<id>/skills/<name>`
- the workflow skill, `skills/issue-to-pr`

At startup the value must be an absolute path with no `.` or `..` segment, and must resolve, through
symlinks, to the app directory that is running; a symlink to it is the intended shape. The segment
rule matters because `<link>/../x` names one directory when read as text and can reach another
through the symlink, and the launcher puts the value into `PATH` exactly as it was checked.
Otherwise the server logs `AW_INSTALL_ROOT ignored` and uses the real directory, because a wrong
value would hand every session a missing hook and no skills. The launcher applies the same rules to
its `PATH` entry. An
extension installed under the data dir keeps its own path. Paths the server reads for itself (the
board's `public/` files, styles, catalog snapshots) still come from the real directory, because the
running process can't outlive it. Unset, every path is the real app directory's, as in a checkout.

Between an upgrade repointing the path and the server restarting, the old server hands new
sessions the new version's hook and skills, and sessions already running pick them up too. The
hook only POSTs a PR URL and swallows every error, so the risk is a new skill naming an MCP tool
the old server doesn't have yet. Those sessions carry the old server's identity, so after the
restart they show as an older version (see [App identity](#app-identity)). A package wrapper keeps
the gap short by restarting the service as soon as it repoints the path.

When that restart doesn't happen, the board notices. At every session launch and once a minute, the
server checks whether `AW_INSTALL_ROOT` still resolves to the running app. The first time it
doesn't, including when the path can't be resolved mid-upgrade, the server logs one
`AW_INSTALL_ROOT … now resolves to …` warning. Settings › Updates then says the upgrade has landed,
with both versions when it can read the new `package.json`, and Settings gets a dot. A supervised
install (`AW_SUPERVISED=1`) offers **Restart now**; any other install says how to restart instead
(`brew services restart agent-wrangler` for `homebrew`). The notice clears once the restarted server
is the version the path points at. Sessions keep the `AW_INSTALL_ROOT` paths meanwhile: the old
version's directory may already be gone.

## App identity

The board reloads open tabs when the app's identity changes, and it tags sessions launched under
a different identity as "older version". **Restart idle sessions after an update** uses the same
identity.

- A checkout is identified by its `HEAD` commit. The startup banner shows `Agent Wrangler 0.1.0 (abc1234)`.
- Anything else is identified by the `version` in its `package.json`. A package upgrade therefore
  changes the identity, while restarting the same package leaves it unchanged.

## Child-process inheritance

Panes must not inherit these signals. A tmux server keeps the environment of the process that
started it, across wrangler restarts, and every pane inherits that environment. A dev instance
started from a pane would otherwise take on the board's identity: its Restart button (which would
kill a process nothing restarts), its permission to apply Git updates, and its install root.

The rule, for every signal in the table above:

1. The server reads each signal once at startup (`server/install-env.js`, the first module
   `server/index.js` imports) and removes it from `process.env` before any tmux server or child
   process can start. Code reads the captured value, never `process.env`.
2. Once it holds the instance lock, the server runs `tmux set-environment -g -u` for each signal on
   its own tmux socket. This removes the signals from a tmux server that an older wrangler started.
3. Panes that already exist keep their environment until they're relaunched. A dev instance (`AW_DEV`)
   never applies a Git update, offers **Restart the wrangler** or uses `AW_INSTALL_ROOT`, even when
   it was started from a pane that still carries the signals.

A new install-scoped signal must be added to `INSTALL_SCOPED_ENV` in `server/install-env.js`.

## Packaging checklist

- Set `AW_INSTALL_MANAGER` in the wrapper, so foreground and service starts both get it.
- Set `AW_SUPERVISED=1` only in the service definition.
- Make the service restart the process after any exit, including a clean one. **Restart the
  wrangler** exits with status 0, so a service that restarts only after a crash (Homebrew's
  `keep_alive crashed: true`) would leave the board stopped. Use `keep_alive true`.
- Never set `AW_GIT_UPDATES`. A package's start path has no checkout rollback or dependency sync.
- Point `AW_NODE` and `AW_INSTALL_ROOT` at upgrade-stable paths (`opt/`, never a versioned `Cellar/` path).
- Restart the service straight after an upgrade repoints `AW_INSTALL_ROOT`, so the running server
  and its sessions' hook and skills don't stay on different versions (see [Session paths](#session-paths)).
