import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Claude Code's "Do you trust this folder?" dialog is suppressed by
// `projects[<path>].hasTrustDialogAccepted === true` in `~/.claude.json`, and
// the entry also covers every descendant of <path> — verified against the
// installed binary (2.1.301): a child of a trusted dir launches straight to the
// prompt, an unrelated dir shows the dialog. So trusting SESSIONS_DIR once
// covers every blank-cwd launch (each lands in a fresh scratch dir beneath it),
// present and future. Never call this for a user's own cwd; a worktree is only
// trusted through mirrorWorktreeTrust, when the repo it was cut from already is.
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

// True when `dirPath` or one of its ancestors has an accepted trust entry, which
// is how Claude itself decides.
function coveredByTrust(projects, dirPath) {
  for (let dir = dirPath; ; dir = path.dirname(dir)) {
    if (projects?.[dir]?.hasTrustDialogAccepted === true) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

// Returns true if the file now trusts `dirPath`. `file` and `log` are injectable
// so tests never touch the real config. With `onlyIfTrusted`, nothing is written
// unless one of those paths (or an ancestor) is already trusted in `authority`
// (default: `file` itself); that check sits in the same synchronous
// read-modify-write as the write itself.
export function ensureClaudeTrust(dirPath, { file = claudeConfigFile(), log = console.warn, onlyIfTrusted, authority = file } = {}) {
  if (!dirPath) return false;
  try {
    const { text, data } = readConfig(file);
    if (data.projects?.[dirPath]?.hasTrustDialogAccepted === true) return true;
    if (data.projects != null && (typeof data.projects !== 'object' || Array.isArray(data.projects))) {
      throw new Error('"projects" is not an object');
    }
    if (onlyIfTrusted) {
      if (coveredByTrust(data.projects, dirPath)) return true;
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

// A linked worktree lives outside its repo (worktrees.noindex/<repo>-<branch>, or
// a legacy <repo>-worktree-<branch> sibling), so the repo's trust entry doesn't
// cover it and Claude asks again. When the main checkout (or an ancestor) is
// trusted, trust that worktree's own root too: never a parent folder, and never a
// worktree of a repo the user hasn't trusted. A plain checkout, a non-repo cwd or
// any git failure is a no-op. Never throws, so it never blocks a launch.
export async function mirrorWorktreeTrust(cwd, opts = {}) {
  if (!cwd) return false;
  let top, gitDir, commonDir;
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
    [top, gitDir, commonDir] = stdout.trim().split('\n');
  } catch {
    return false;
  }
  if (!top || !gitDir || !commonDir || gitDir === commonDir) return false;
  // A non-bare repo's common dir is <root>/.git; a bare repo's is the repo itself.
  const source = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return ensureClaudeTrust(top, { ...opts, onlyIfTrusted: [...new Set([source, real(source)])] });
}

const realPath = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

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
  ensureClaudeTrust(cwd, { file, authority: serverFile, onlyIfTrusted: [...new Set([cwd, realPath(cwd)])], log });
  return true;
}
