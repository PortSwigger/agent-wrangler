#!/bin/bash
# An update from the board (server/self-update.js) writes this marker before it
# fast-forwards, and the new server deletes it once it has stayed up for a while.
# Still here on the Nth start means the new code never got that far, so step
# back to the commit it came from rather than leave the supervisor respawning a
# board that cannot boot.
cd "$(dirname "$0")/.." || exit 1

AW_STATE_DIR="${AW_DATA_DIR:-$HOME/.agent-wrangler}"
AW_STATE_DIR="${AW_STATE_DIR/#\~/$HOME}"
ROLLBACK_MARKER="$AW_STATE_DIR/update-rollback"
AW_ROLLBACK_AFTER_STARTS="${AW_ROLLBACK_AFTER_STARTS:-3}"
if [ -f "$ROLLBACK_MARKER" ]; then
  rb_previous="$(sed -n 's/^previous=//p' "$ROLLBACK_MARKER")"
  rb_target="$(sed -n 's/^target=//p' "$ROLLBACK_MARKER")"
  rb_attempts="$(sed -n 's/^attempts=//p' "$ROLLBACK_MARKER")"
  rb_attempts=$(( ${rb_attempts:-0} + 1 ))
  if [ "$rb_attempts" -ge "$AW_ROLLBACK_AFTER_STARTS" ] && [ -n "$rb_previous" ]; then
    if git reset --keep "$rb_previous"; then
      printf 'previous=%s\ntarget=%s\nat=%s\n' "$rb_previous" "$rb_target" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$AW_STATE_DIR/update-rolled-back"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [agent-wrangler] update to $rb_target failed to start $((rb_attempts - 1)) times; rolled back to $rb_previous"
    else
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [agent-wrangler] update to $rb_target failed to start and rolling back to $rb_previous failed too"
    fi
    rm -f "$ROLLBACK_MARKER"
  else
    printf 'previous=%s\ntarget=%s\nattempts=%s\n' "$rb_previous" "$rb_target" "$rb_attempts" > "$ROLLBACK_MARKER"
  fi
fi
