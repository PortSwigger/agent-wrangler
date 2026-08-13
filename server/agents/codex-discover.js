import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

// Pull the trailing UUID out of `rollout-<ts>-<uuid>.jsonl`.
function uuidFromName(name) {
  const m = name.match(/^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/);
  return m ? m[1] : null;
}

// Read the SessionMeta cwd from the first line of a rollout. A freshly-launched
// session is never pre-compressed, so plain .jsonl only here.
function rolloutCwd(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').split('\n', 1)[0] || '';
    const entry = JSON.parse(head);
    return entry?.payload?.cwd || entry?.cwd || null;
  } catch {
    return null;
  }
}

// Codex resolves its own cwd (e.g. macOS /tmp -> /private/tmp) before recording
// it in SessionMeta, but the wrangler's stored entry.cwd is whatever raw path it
// was launched with — an exact string compare between the two silently fails to
// discover a live-but-symlinked session (falls back to `p` when it doesn't exist
// on disk, e.g. a fixture path in tests or a since-removed worktree).
function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Every rollout under the sessions tree, newest mtime first.
async function allRollouts(sessionsDir) {
  const out = [];
  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) out.push({ full, name: e.name, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(sessionsDir);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The Codex session id for a session launched in `cwd` at `launchedAt` (ms):
// newest rollout written at/after launch whose SessionMeta cwd matches. A small
// negative slop on launchedAt absorbs clock/rounding skew vs the file mtime.
export async function discoverCodexLiveId({ cwd, launchedAt = 0, sessionsDir = CODEX_SESSIONS } = {}) {
  const floor = launchedAt - 2000;
  const target = realpathOrSelf(cwd);
  for (const r of await allRollouts(sessionsDir)) {
    if (r.mtimeMs < floor) break; // sorted newest-first; nothing older can match
    const rc = rolloutCwd(r.full);
    if (rc != null && realpathOrSelf(rc) === target) return uuidFromName(r.name);
  }
  return null;
}
