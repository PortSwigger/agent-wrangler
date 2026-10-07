#!/bin/sh
# Shared by checkout startup (before dependency sync) and the installed launcher.
# launchd never rotates StandardOutPath/StandardErrorPath — it opens them once and
# appends forever — so the log grows without bound, and it carries a line per
# server start/stop and per session lifecycle event. Trimmed here, at startup,
# because there is nowhere else to do it safely: launchd holds an fd on the
# INODE, so renaming the file sends every later write to an orphan and logging
# silently stops. Truncate in place (`cat` back over it, never `mv`); the held fd
# is O_APPEND, so writes simply resume after the kept tail.
#
# Only under a supervisor (AW_SUPERVISED=1, set by wrangler-start.sh and by the
# Homebrew service): an interactive run writes to the terminal. The source
# launchd plist and Homebrew formula use wrangler.log/wrangler.err; set AW_LOG_DIR
# to their directory. Homebrew can write these files on macOS or Linux, so both
# platforms use this trimming. The source-install systemd unit instead writes
# to the journal, which manages its own retention; missing log files are a no-op.
trim_log() {
  # POSIX sh has no `local`; the prefix keeps these out of the caller's way.
  _tl_f="$1"; _tl_max="$2"
  [ -f "$_tl_f" ] || return 0
  _tl_size=$(wc -c < "$_tl_f" 2>/dev/null | tr -d ' ') || return 0
  [ -n "$_tl_size" ] && [ "$_tl_size" -gt "$_tl_max" ] || return 0
  _tl_tmp="$_tl_f.trim.$$"
  # Drop the partial first line the byte-offset cut leaves behind, and say in the
  # log itself that history was dropped — otherwise it just appears to begin
  # mid-sentence at an arbitrary date.
  if tail -c "$_tl_max" "$_tl_f" 2>/dev/null | tail -n +2 > "$_tl_tmp" 2>/dev/null; then
    cat "$_tl_tmp" > "$_tl_f" \
      && printf '%s [agent-wrangler] log trimmed at startup to the last %s bytes (older lines dropped)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_tl_max" >> "$_tl_f"
  fi
  rm -f "$_tl_tmp"
}
if [ "${AW_SUPERVISED:-}" = 1 ]; then
  AW_LOG_DIR="${AW_LOG_DIR:-$HOME/Library/Logs/wrangler}"
  AW_LOG_MAX_BYTES="${AW_LOG_MAX_BYTES:-2097152}"
  trim_log "$AW_LOG_DIR/wrangler.log" "$AW_LOG_MAX_BYTES"
  trim_log "$AW_LOG_DIR/wrangler.err" "$AW_LOG_MAX_BYTES"
fi

