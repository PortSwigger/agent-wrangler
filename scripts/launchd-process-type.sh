#!/bin/sh
# Sourced by wrangler-start.sh. launchd runs a LaunchAgent whose plist sets no
# ProcessType as a background daemon, at a lower CPU priority and with throttled
# IO, and the server, its tmux server and every session pane inherit that. While
# something else keeps the CPU busy (containers running test suites, say) sessions
# take seconds to open and lag, though `claude` started from a terminal keeps up.
# The plist template sets ProcessType Interactive; this adds it to a plist made
# from an older template.
#
# The plist is the job's own, named after the label launchd exports as
# XPC_SERVICE_NAME, which systemd and terminal starts don't set. Left alone: a
# plist that sets any ProcessType (the user's choice), a package manager's install
# (AW_INSTALL_MANAGER), whose plist the package manager writes, and a plist this
# user can't write. launchd reads a plist only when it loads the job, at login or
# on bootout + bootstrap, never on a KeepAlive respawn or kickstart, so the change
# applies from the next login.
aw_interactive_process_type() {
  # Non-blank, as server/install-env.js reads it.
  case "${AW_INSTALL_MANAGER:-}" in *[![:space:]]*) return 0 ;; esac
  [ -n "${XPC_SERVICE_NAME:-}" ] && command -v plutil >/dev/null 2>&1 || return 0
  _pt_plist="$HOME/Library/LaunchAgents/$XPC_SERVICE_NAME.plist"
  [ -f "$_pt_plist" ] || return 0
  plutil -extract ProcessType raw "$_pt_plist" >/dev/null 2>&1 && return 0
  # Inserted as text before the last </dict>, the one closing the top-level dict,
  # because plutil -insert rewrites the whole file and drops its comments. Written
  # back only once plutil reads the new key from the result, and in place, so a
  # symlinked plist stays a symlink.
  if [ -w "$_pt_plist" ] && _pt_new=$(awk '
    NR == FNR {
      if (/<\/dict>/) last = FNR
      if (!seen && /<key>Label<\/key>/) { seen = 1; match($0, /^[ \t]*/); indent = substr($0, 1, RLENGTH) }
      next
    }
    FNR == last {
      print ""
      print indent "<!-- Unset, launchd throttles this as a background daemon, and every session inherits that priority. -->"
      print indent "<key>ProcessType</key>"
      print indent "<string>Interactive</string>"
    }
    { print }
  ' "$_pt_plist" "$_pt_plist") \
    && [ "$(printf '%s\n' "$_pt_new" | plutil -extract ProcessType raw - 2>/dev/null)" = Interactive ] \
    && printf '%s\n' "$_pt_new" > "$_pt_plist"; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [agent-wrangler] added ProcessType Interactive to $_pt_plist; launchd applies it from your next login"
  else
    printf 'agent-wrangler: %s sets no ProcessType, so launchd runs this service as a background daemon and sessions lag while the machine is busy. Set its ProcessType to Interactive (see Snags in the README).\n' "$_pt_plist" >&2
  fi
}

aw_interactive_process_type
