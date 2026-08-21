import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_DIR } from '../claude-paths.js';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Claude Code names a project bucket after the launch cwd with `/` and `.`
// flattened to `-`. Same encoding as usage-report.js's private `bucketName`, and
// deliberately re-stated rather than imported: this module is an agents/* leaf and
// must not drag in the whole usage scan engine (and its module-level caches) just
// to spell a directory name.
const bucketName = (cwd) => (cwd || '').replace(/[/.]/g, '-');

// Claude resolves its cwd before deriving the bucket name, but the wrangler's
// stored entry.cwd is the raw path it launched with — on macOS a `/tmp/...` cwd
// buckets under `-private-tmp-...`, so an unresolved-only lookup silently finds
// nothing. Falls back to `p` for a path that doesn't exist on disk (a fixture path
// in tests, or a worktree already removed).
function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Every transcript directly in a bucket dir, newest mtime first. Non-recursive on
// purpose: a session's own conversation file sits at the bucket root, while the
// nested `<uuid>/subagents/` dirs hold sub-agent artifacts that are never a
// conversation id you can resume.
async function transcriptsIn(dir) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (st) out.push({ name: e.name, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The conversation id of the Claude session just launched in `cwd` at `launchedAt`
// (ms): newest transcript in that cwd's project bucket written at/after launch, its
// uuid being the filename stem. Used for the discovered-after-launch shape (a
// teleport, where the id is minted by the CLI rather than passed in), mirroring
// codex-discover.js — including the small negative slop, which absorbs
// clock/rounding skew between our launch timestamp and the file's mtime. Null when
// nothing qualifies, so the caller can keep polling or refuse to convert rather
// than adopt a stale conversation.
export async function discoverClaudeLiveIdAfter({ cwd, launchedAt = 0, projectsDir = PROJECTS_DIR } = {}) {
  const floor = launchedAt - 2000;
  // Both spellings: the bucket is keyed on the resolved path, but a caller may pass
  // either, and a raw path that no longer exists realpaths to itself.
  const buckets = [...new Set([bucketName(realpathOrSelf(cwd)), bucketName(cwd)])].filter(Boolean);
  let best = null;
  for (const b of buckets) {
    // Sorted newest-first, so only the head can qualify: anything behind it is
    // both older than it and, if the head misses the floor, older than the floor.
    const [head] = await transcriptsIn(path.join(projectsDir, b));
    if (head && head.mtimeMs >= floor && (!best || head.mtimeMs > best.mtimeMs)) best = head;
  }
  return best ? best.name.slice(0, -6) : null;
}
