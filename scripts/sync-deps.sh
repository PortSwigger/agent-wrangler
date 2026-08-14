#!/bin/bash
# Reconcile node_modules with package-lock.json, but only when the lockfile has
# changed since the last successful install (a hash stamp under node_modules).
# Shared by npm's `prestart` hook and the launchd start script so both run paths
# self-heal after a dependency change instead of crash-looping on a missing
# module. A failed install exits non-zero rather than leaving half-installed
# deps; the stamp is written only on success so a failure retries next start.
cd "$(dirname "$0")/.." || exit 1

# shasum ships with macOS/Perl but is absent from slim Linux images; sha1sum
# (coreutils) is the equivalent there.
if command -v shasum >/dev/null 2>&1; then
  LOCK_HASH="$(shasum package-lock.json | cut -d' ' -f1)"
else
  LOCK_HASH="$(sha1sum package-lock.json | cut -d' ' -f1)"
fi
STAMP="node_modules/.lockhash"
if [ "$(cat "$STAMP" 2>/dev/null)" != "$LOCK_HASH" ]; then
  npm ci || exit 1
  echo "$LOCK_HASH" > "$STAMP"
fi
