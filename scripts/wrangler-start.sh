#!/bin/bash
# Launcher for the launchd agent (net.portswigger.agent-wrangler) and the systemd
# user unit, for installs run from a git checkout. Resolves Node via nvm at
# runtime — using whatever the nvm "default" alias points at — so the service
# keeps working across Node upgrades instead of pinning a version path, keeps
# node_modules in step with the lockfile, then execs bin/agent-wrangler, which
# owns the rest of the process environment (locale, fd limit, PATH).

# Both supervisors above (launchd KeepAlive, systemd Restart=always) bring the
# process straight back, which is what makes the board's "Restart the wrangler"
# button — the one that finishes an extension install or uninstall — safe to
# offer. Nothing exports this on the `npm start` or bare-launcher paths, so there
# the button is simply absent rather than a way to kill the board.
export AW_SUPERVISED=1

# Trim before nvm and dependency sync: either can fail before the launcher runs.
. "$(dirname "$0")/trim-service-logs.sh"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --silent default >/dev/null 2>&1 || true

cd "$(dirname "$0")/.." || exit 1

# Steps back to the pre-update commit when an update from the board has left a
# server that cannot boot. Before sync-deps, so a failed `npm ci` counts too.
bash scripts/update-rollback.sh

# server (node-pty) panes inherit this PATH; devcontainer sessions run
# `devcontainer up`/`exec` in a pane, and @devcontainers/cli installs to
# node_modules/.bin. Appended (not prepended) so system binaries still win —
# only fills the `devcontainer` gap. The `npm start` path gets this for free.
export PATH="$PATH:$PWD/node_modules/.bin"

# The supervisor PATHs (launchd plist, systemd unit) predate this and omit the
# sbin dirs, so sessions could not find macOS tools like pkgutil — which mise
# needs to install .pkg-based tools (awscli), failing with "No such file or
# directory". Filled here rather than in the templates so existing installs
# self-heal on their next restart without editing their plist.
for d in /usr/sbin /sbin; do
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac
done
export PATH

# A tmux server outlives the wrangler and keeps the PATH it started with, so new
# panes would go on inheriting a stale one. Bring any running session servers
# into line with this PATH; it only affects panes created from here on.
for sock in "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"/aw-*; do
  [ -S "$sock" ] && tmux -S "$sock" set-environment -g PATH "$PATH" 2>/dev/null || true
done

# Keep node_modules in lockstep with the lockfile so a restart after a dependency
# change self-heals instead of crash-looping on a missing module. Shared with
# npm's prestart hook so the launchd and `npm start` paths behave identically.
# Deliberately NOT in bin/agent-wrangler: a Homebrew install dir is immutable and
# has its dependencies installed at build time, so only checkout start paths run it.
bash scripts/sync-deps.sh || exit 1

exec "$PWD/bin/agent-wrangler"
