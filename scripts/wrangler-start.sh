#!/bin/bash
# Launcher for the launchd agent (net.portswigger.agent-wrangler) and the systemd
# user unit, for installs run from a git checkout. Resolves Node via nvm at
# runtime — using whatever the nvm "default" alias points at — so the service
# keeps working across Node upgrades instead of pinning a version path, keeps
# node_modules in step with the lockfile, then execs bin/agent-wrangler, which
# owns the rest of the process environment (locale, fd limit, PATH).

# launchd never rotates StandardOutPath/StandardErrorPath — it opens them once and
# appends forever — so the log grows without bound, and it now carries a line per
# server start/stop and per session lifecycle event rather than almost nothing.
# Trimmed here, at startup, because there is nowhere else to do it safely: launchd
# holds an fd on the INODE, so renaming the file sends every later write to an
# orphan and logging silently stops. Truncate in place (`cat` back over it, never
# `mv`); the held fd is O_APPEND, so writes simply resume after the kept tail.
# The systemd path logs to the journal, which rotates itself — these files won't
# exist there, and the function no-ops.
trim_log() {
  local f="$1" max="$2" size tmp
  [ -f "$f" ] || return 0
  size=$(wc -c < "$f" 2>/dev/null | tr -d ' ') || return 0
  [ -n "$size" ] && [ "$size" -gt "$max" ] || return 0
  tmp="$f.trim.$$"
  # Drop the partial first line the byte-offset cut leaves behind, and say in the
  # log itself that history was dropped — otherwise it just appears to begin
  # mid-sentence at an arbitrary date.
  if tail -c "$max" "$f" 2>/dev/null | tail -n +2 > "$tmp" 2>/dev/null; then
    cat "$tmp" > "$f" \
      && printf '%s [agent-wrangler] log trimmed at startup to the last %s bytes (older lines dropped)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$max" >> "$f"
  fi
  rm -f "$tmp"
}
AW_LOG_DIR="${AW_LOG_DIR:-$HOME/Library/Logs/wrangler}"
AW_LOG_MAX_BYTES="${AW_LOG_MAX_BYTES:-2097152}"
trim_log "$AW_LOG_DIR/wrangler.log" "$AW_LOG_MAX_BYTES"
trim_log "$AW_LOG_DIR/wrangler.err" "$AW_LOG_MAX_BYTES"

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
