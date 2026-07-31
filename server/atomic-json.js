import fs from 'node:fs';
import path from 'node:path';

// Shared crash-safe JSON persistence for the three state stores (mappings,
// tasks, config). A bare truncate-in-place writeFileSync can leave a torn or
// empty file if the process dies mid-write — and for mappings.json that orphans
// every running tmux session, since the loader then has no resume target. Mirror
// the temp-file + renameSync pattern memory-store already uses for its symlink:
// rename is atomic on the same filesystem, so a reader (or the next startup)
// sees either the old file or the whole new one, never a half-written one.
// `trailingNewline` preserves each call site's exact byte output so diffs and
// round-trips stay stable (config writes one; mappings/tasks don't).
export function writeJsonAtomic(file, obj, { trailingNewline = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(obj, null, 2) + (trailingNewline ? '\n' : '');
  // Temp file in the SAME dir so the rename stays on one filesystem (a cross-fs
  // rename isn't atomic and would fall back to a copy). `.tmp` suffix, removed
  // by the rename on success.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

// Read + parse a state file, distinguishing "first run" from "corruption". A
// missing or empty file is a legitimate first run → return null quietly so the
// caller starts empty. A NON-empty file that fails to parse is corruption: do
// NOT silently discard it (that would orphan live sessions). Move it aside under
// a stable `.corrupt` sibling (never clobbering an existing backup — append a
// counter) for recovery, log loudly, and return null so this background service
// still comes up. Continuing-with-empty-after-a-loud-backup is chosen over
// throwing because the service must start; the corrupt file is kept for repair.
export function readJsonOrLoud(file, label = file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no file yet — legitimate first run
  }
  if (raw.trim() === '') return null; // empty file — also a clean first run
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = backupCorrupt(file);
    console.error(
      `[agent-wrangler] ${label} is corrupt and could not be parsed (${err.message}). ` +
        `Backed it up to ${backup} and starting from empty state — recover from the backup if needed.`
    );
    return null;
  }
}

// Move the corrupt bytes aside without destroying an earlier backup: try
// `<file>.corrupt`, then `.corrupt.1`, `.corrupt.2`, … (no Date.now()/random, so
// the name is deterministic). Rename rather than copy so the canonical path is
// left absent — otherwise every restart re-reads the same corrupt file, re-fires
// the loud warning, and spawns another `.corrupt.N`. A clean first save then
// rewrites the canonical file atomically. Best-effort — a failed backup must not
// stop startup, so we still return the attempted path for the log.
function backupCorrupt(file) {
  let target = `${file}.corrupt`;
  for (let n = 1; fs.existsSync(target); n++) target = `${file}.corrupt.${n}`;
  try {
    fs.renameSync(file, target);
  } catch {
    /* best-effort: keep coming up even if the backup can't be written */
  }
  return target;
}
