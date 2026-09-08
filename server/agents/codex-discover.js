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

// When a rollout was minted, from its own filename (`rollout-<YYYY-MM-DD>T<HH-MM-SS>-<uuid>.jsonl`,
// written in local time). mtime can't answer this: resuming an old conversation rewrites
// its file, so a superseded rollout can carry today's mtime. Null when the name doesn't
// carry a timestamp — callers treat that as "unknown, don't exclude".
function mintedAtFromName(name) {
  const m = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : null;
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
// `mintedAfter` additionally excludes rollouts minted before that time — for callers
// resolving an id long after launch, where mtime says only when a file was last
// touched and cwd alone would match any session the directory has ever hosted.
export async function discoverCodexLiveId({ cwd, launchedAt = 0, mintedAfter = 0, sessionsDir = CODEX_SESSIONS } = {}) {
  const floor = launchedAt - 2000;
  const target = realpathOrSelf(cwd);
  for (const r of await allRollouts(sessionsDir)) {
    if (r.mtimeMs < floor) break; // sorted newest-first; nothing older can match
    if (mintedAfter) {
      const minted = mintedAtFromName(r.name);
      if (minted != null && minted < mintedAfter) continue; // predates the caller's session
    }
    const rc = rolloutCwd(r.full);
    if (rc != null && realpathOrSelf(rc) === target) return uuidFromName(r.name);
  }
  return null;
}
