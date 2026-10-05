import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './data-dir.js';

const execFileAsync = promisify(execFile);

export const INSTALL_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const UPDATE_REMOTE = 'origin';
export const UPDATE_BRANCH = 'main';
const UPSTREAM = `${UPDATE_REMOTE}/${UPDATE_BRANCH}`;
const MAX_LISTED_COMMITS = 50;

const defaultGit = (args, opts = {}) => execFileAsync('git', args, { cwd: INSTALL_ROOT, timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...opts });

async function gitOut(git, args) {
  const { stdout } = await git(args);
  return String(stdout).trim();
}

export async function readCodeVersion({ git = defaultGit } = {}) {
  try {
    return await gitOut(git, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

function parseCommits(stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t') };
  });
}

export function blockedReason({ branch, dirty, ahead }) {
  if (branch !== UPDATE_BRANCH) return `The install checkout is on "${branch}", not ${UPDATE_BRANCH}. Switch it back to ${UPDATE_BRANCH} to update from the board.`;
  if (dirty) return 'The install checkout has uncommitted changes. Commit, stash or discard them to update from the board.';
  if (ahead > 0) return `The install checkout has ${ahead} local commit${ahead === 1 ? '' : 's'} not on ${UPSTREAM}, so it cannot fast-forward.`;
  return null;
}

async function inspect(git) {
  const [branch, status, head, remote, counts] = await Promise.all([
    gitOut(git, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOut(git, ['status', '--porcelain', '--untracked-files=no']),
    gitOut(git, ['rev-parse', 'HEAD']),
    gitOut(git, ['rev-parse', UPSTREAM]),
    gitOut(git, ['rev-list', '--left-right', '--count', `HEAD...${UPSTREAM}`]),
  ]);
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  const commits = behind > 0
    ? parseCommits(await gitOut(git, ['log', `--max-count=${MAX_LISTED_COMMITS}`, '--format=%h%x09%s', `HEAD..${UPSTREAM}`]))
    : [];
  return { head, remote, behind, commits, blocked: blockedReason({ branch, dirty: status.length > 0, ahead }) };
}

export async function checkForUpdate({ git = defaultGit } = {}) {
  await git(['fetch', '--quiet', UPDATE_REMOTE, UPDATE_BRANCH]);
  return inspect(git);
}

export async function applyUpdate({ git = defaultGit, beforeMerge = () => {} } = {}) {
  const status = await checkForUpdate({ git });
  if (status.blocked) throw new Error(status.blocked);
  if (status.behind === 0) return { ...status, updated: false };
  beforeMerge(status);
  await git(['merge', '--ff-only', '--quiet', UPSTREAM]);
  return { ...status, head: await gitOut(git, ['rev-parse', 'HEAD']), updated: true };
}

// Both files are key=value lines rather than JSON because scripts/wrangler-start.sh
// reads and rewrites them with sed, before any of the newly pulled Node code runs.
export const ROLLBACK_MARKER = 'update-rollback';
export const ROLLED_BACK_NOTE = 'update-rolled-back';

function readKeyValues(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

export function writeRollbackMarker({ previous, target }, { dataDir = DATA_DIR } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, ROLLBACK_MARKER), `previous=${previous}\ntarget=${target}\nattempts=0\n`);
  fs.rmSync(path.join(dataDir, ROLLED_BACK_NOTE), { force: true });
}

export function clearRollbackMarker({ dataDir = DATA_DIR } = {}) {
  fs.rmSync(path.join(dataDir, ROLLBACK_MARKER), { force: true });
}

export function readRolledBack({ dataDir = DATA_DIR } = {}) {
  const note = readKeyValues(path.join(dataDir, ROLLED_BACK_NOTE));
  return note?.target ? { previous: note.previous || null, target: note.target, at: note.at || null } : null;
}
