import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Claude Code's "Do you trust this folder?" dialog is suppressed by
// `projects[<path>].hasTrustDialogAccepted === true` in `~/.claude.json`. Since
// 2.1.319 (read from the binary) which entries count depends on git: inside a
// repo, the canonical repo root's entry (for a linked worktree, the main
// checkout) or one on the walk from the folder up to its own git top; entries
// above the git top are ignored. Outside git, any ancestor still counts. So
// trusting SESSIONS_DIR once covers every blank-cwd launch (each lands in a
// fresh scratch dir beneath it), but a trusted ~/code no longer covers a
// worktree of a repo under it. Never call this for a user's own cwd; a worktree
// is only trusted through mirrorWorktreeTrust, when the repo it was cut from
// (or an ancestor of it) already is.
//
// `~/.claude.json` is big and rewritten live by running Claude sessions, so this
// writer is conservative: idempotent (no write when already trusted), atomic
// (temp file + rename, mode preserved), re-reads immediately before writing and
// does the check/modify/write with no `await` in between, and skips (logging)
// anything it can't parse rather than overwrite it. Failures never block a launch.

function claudeConfigFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { text: '', data: {} };
    throw e;
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  return { text, data };
}

// True when `dirPath` or an ancestor has an accepted entry. With `top` (the
// folder's git top) the walk stops there, as Claude's does inside a repo. The
// repo root's own entry is deliberately not counted: Claude before 2.1.319
// ignores it for a worktree outside the repo, and an extra entry is harmless.
// What authorises a write is always the unbounded walk.
function coveredByTrust(projects, dirPath, top) {
  for (let dir = dirPath; ; dir = path.dirname(dir)) {
    if (projects?.[dir]?.hasTrustDialogAccepted === true) return true;
    if (path.dirname(dir) === dir || (top && !dir.startsWith(top + path.sep))) return false;
  }
}

// Returns true if the file now trusts `dirPath`. `file` and `log` are injectable
// so tests never touch the real config. With `onlyIfTrusted`, nothing is written
// unless one of those paths (or an ancestor) is already trusted in `authority`
// (default: `file` itself); that check sits in the same synchronous
// read-modify-write as the write itself. `gitTop` bounds what already counts as
// trusted in `file` to Claude's in-repo rule.
export function ensureClaudeTrust(dirPath, { file = claudeConfigFile(), log = console.warn, onlyIfTrusted, authority = file, gitTop } = {}) {
  if (!dirPath) return false;
  try {
    const { text, data } = readConfig(file);
    if (data.projects?.[dirPath]?.hasTrustDialogAccepted === true) return true;
    if (data.projects != null && (typeof data.projects !== 'object' || Array.isArray(data.projects))) {
      throw new Error('"projects" is not an object');
    }
    if (onlyIfTrusted) {
      if (coveredByTrust(data.projects, dirPath, gitTop)) return true;
      const granted = authority === file ? data.projects : readConfig(authority).data.projects;
      if (!onlyIfTrusted.some((p) => coveredByTrust(granted, p))) return false;
    }

    data.projects ??= {};
    data.projects[dirPath] = { ...(data.projects[dirPath] || {}), hasTrustDialogAccepted: true };
    const indent = /^\{\n( +)"/.exec(text)?.[1].length ?? 2;
    const out = JSON.stringify(data, null, indent) + (text === '' || text.endsWith('\n') ? '\n' : '');

    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.wrangler-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, out, { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return true;
  } catch (e) {
    log(`[claude-trust] skipped trusting ${dirPath} in ${file}: ${e.message}`);
    return false;
  }
}

const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// `cwd`'s git top, whether it is a linked worktree, and the repo it belongs to
// (a worktree's main checkout; a bare repo's own dir), plain and realpathed.
// Null outside a repo or on any git failure.
async function gitScope(cwd) {
  let top, gitDir, commonDir;
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
    [top, gitDir, commonDir] = stdout.trim().split('\n');
  } catch {
    return null;
  }
  if (!top || !gitDir || !commonDir) return null;
  // A non-bare repo's common dir is <root>/.git; a bare repo's is the repo itself.
  const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return { top, linked: gitDir !== commonDir, roots: [...new Set([root, realPath(root)])] };
}

// A linked worktree lives outside its repo (worktrees.noindex/<repo>-<branch>, or
// a legacy <repo>-worktree-<branch> sibling), and a trusted folder above it
// (~/code) no longer covers it, so Claude asks again. When the main
// checkout (or an ancestor) is trusted, trust that worktree's own root too:
// never a parent folder, and never a worktree of a repo the user hasn't
// trusted. A plain checkout, a non-repo cwd or any git failure is a no-op.
// Never throws, so it never blocks a launch.
export async function mirrorWorktreeTrust(cwd, opts = {}) {
  if (!cwd) return false;
  const scope = await gitScope(cwd);
  if (!scope?.linked) return false;
  return ensureClaudeTrust(scope.top, { ...opts, gitTop: scope.top, onlyIfTrusted: scope.roots });
}

// A login's own Claude config dir (the CLAUDE_CONFIG_DIR a launch context sets)
// gets the same trust a default launch writes, authorised only by the server's
// config: SESSIONS_DIR, a worktree whose repo the server config trusts, and the
// launch cwd itself when the server config already covers it. Nothing the
// login's own file trusts authorises anything. The dir must already exist (it
// is never created), must not be the server's own or the CLI's default config
// dir, and a symlinked .claude.json is left alone. Never throws.
export async function ensureLoginClaudeTrust(configDir, { cwd, sessionsDir, serverFile = claudeConfigFile(), log = console.warn } = {}) {
  const skip = (why) => { log(`[claude-trust] skipped login config ${JSON.stringify(configDir)}: ${why}`); return false; };
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir)) return skip('not an absolute path');
  try {
    if (!fs.statSync(configDir).isDirectory()) return skip('not a directory');
  } catch {
    return skip('does not exist');
  }
  const dir = realPath(configDir);
  const reserved = [path.dirname(serverFile), os.homedir(), path.join(os.homedir(), '.claude')].map(realPath);
  if (reserved.includes(dir)) return skip('is the server or default Claude config dir');
  const file = path.join(configDir, '.claude.json');
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return skip('.claude.json is a symlink');
  } catch { /* no file yet */ }
  if (sessionsDir) ensureClaudeTrust(sessionsDir, { file, log });
  if (!cwd) return true;
  await mirrorWorktreeTrust(cwd, { file, authority: serverFile, log });
  const gitTop = (await gitScope(cwd))?.top;
  ensureClaudeTrust(cwd, { file, authority: serverFile, gitTop, onlyIfTrusted: [...new Set([cwd, realPath(cwd)])], log });
  return true;
}
