#!/bin/bash
# Launcher for the launchd agent (net.portswigger.agent-wrangler) and the systemd
# user unit, for installs run from a git checkout. Resolves Node via nvm at
# runtime — using whatever the nvm "default" alias points at — so the service
# keeps working across Node upgrades instead of pinning a version path, keeps
# node_modules in step with the lockfile, then execs bin/agent-wrangler, which
# owns the rest of the process environment (locale, fd limit, PATH).

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use --silent default >/dev/null 2>&1 || true

cd "$(dirname "$0")/.." || exit 1

# Keep node_modules in lockstep with the lockfile so a restart after a dependency
# change self-heals instead of crash-looping on a missing module. Shared with
# npm's prestart hook so the launchd and `npm start` paths behave identically.
# Deliberately NOT in bin/agent-wrangler: a Homebrew install dir is immutable and
# has its dependencies installed at build time, so only checkout start paths run it.
bash scripts/sync-deps.sh || exit 1

# Both supervisors above (launchd KeepAlive, systemd Restart=always) bring the
# process straight back, which is what makes the board's "Restart the wrangler"
# button — the one that finishes an extension install or uninstall — safe to
# offer. Nothing exports this on the `npm start` or bare-launcher paths, so there
# the button is simply absent rather than a way to kill the board.
export AW_SUPERVISED=1

exec "$PWD/bin/agent-wrangler"
