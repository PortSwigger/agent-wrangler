#!/bin/bash
# Launcher for the launchd agent (net.portswigger.agent-wrangler). Resolves Node via nvm at
# runtime — using whatever the nvm "default" alias points at — so the service
# keeps working across Node upgrades instead of pinning a version path.
# launchd doesn't inherit the login locale; without a UTF-8 locale tmux renders
# Unicode (⏺, box-drawing, em-dash) as "_" in attached terminals.
export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-$LANG}"

# Pin the open-file limit so every launch path (launchd, `npm start`) behaves
# identically. This is a blast-radius backstop, not a leak canary — that job moved
# to server/fd-watchdog.js, because Node self-raises its own soft fd limit to the
# hard limit at startup regardless of what this ulimit sets, so a low ceiling here
# only ever capped everything in the tree uniformly (including one-shot MCP
# children like chrome-devtools-mcp, which needs a ~270-fd burst at startup and
# was dying to EMFILE against the old 256 default). Set well above any legitimate
# peak so it only ever fires to contain a truly runaway leak — override with
# AW_MAX_FILES if you need something different.
ulimit -n "${AW_MAX_FILES:-16384}" 2>/dev/null || true

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

# server (node-pty) panes inherit this PATH; devcontainer sessions run
# `devcontainer up`/`exec` in a pane, and @devcontainers/cli installs to
# node_modules/.bin. Appended (not prepended) so system binaries still win —
# only fills the `devcontainer` gap. The `npm start` path gets this for free.
export PATH="$PATH:$PWD/node_modules/.bin"

# Keep node_modules in lockstep with the lockfile so a restart after a dependency
# change self-heals instead of crash-looping on a missing module. Shared with
# npm's prestart hook so the launchd and `npm start` paths behave identically.
bash scripts/sync-deps.sh || exit 1

exec node server/index.js
