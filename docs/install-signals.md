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
| `AW_INSTALL_ROOT` | directory | the real app directory | a package wrapper | An upgrade-stable path to the app, such as Homebrew's `opt/agent-wrangler/libexec`. The launcher builds the `node_modules/.bin` entry it adds to `PATH` from it. Git never runs here; it always runs in the real app directory. |
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
   never applies a Git update or offers **Restart the wrangler**, even when it was started from a
   pane that still carries the signals.

A new install-scoped signal must be added to `INSTALL_SCOPED_ENV` in `server/install-env.js`.

## Packaging checklist

- Set `AW_INSTALL_MANAGER` in the wrapper, so foreground and service starts both get it.
- Set `AW_SUPERVISED=1` only in the service definition.
- Never set `AW_GIT_UPDATES`. A package's start path has no checkout rollback or dependency sync.
- Point `AW_NODE` and `AW_INSTALL_ROOT` at upgrade-stable paths (`opt/`, never a versioned `Cellar/` path).
