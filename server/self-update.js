import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './data-dir.js';
import { VERSION } from './version.js';

const execFileAsync = promisify(execFile);

// The real directory this code runs from, derived from import.meta.url. Git
// always runs here, never in AW_INSTALL_ROOT (task 06's session-facing path,
// which may be a symlink that a package upgrade repoints).
export const APP_ROOT = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const UPDATE_REMOTE = 'origin';
export const UPDATE_BRANCH = 'main';
const UPSTREAM = `${UPDATE_REMOTE}/${UPDATE_BRANCH}`;
const MAX_LISTED_COMMITS = 50;

// Env vars that make git operate on a repository other than the one found from
// its working directory: the list `git rev-parse --local-env-vars` prints, plus
// the two that widen discovery. One inherited from a parent git process (a hook,
// `git rebase --exec`) would otherwise point every command below at that repo.
const REDIRECTING_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

// The ceiling stops git walking up out of the app root, so a Homebrew keg (inside
// Homebrew's own repository on Apple Silicon) or an unpacked tarball inside some
// other checkout finds no repository at all rather than the enclosing one.
export function checkoutGitEnv(env, appRoot) {
  const out = { ...env };
  for (const name of REDIRECTING_GIT_ENV) delete out[name];
  out.GIT_CEILING_DIRECTORIES = path.dirname(appRoot);
  return out;
}

export function gitFor(appRoot) {
  return (args, opts = {}) => execFileAsync('git', args, {
    cwd: appRoot, env: checkoutGitEnv(process.env, appRoot), timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...opts,
  });
}

const defaultGit = gitFor(APP_ROOT);

async function gitOut(git, args) {
  const { stdout } = await git(args);
  return String(stdout).trim();
}

export class NotACheckoutError extends Error {
  constructor() {
    super('This install is not a Git checkout of agent-wrangler, so it cannot update from the board.');
    this.name = 'NotACheckoutError';
  }
}

// Whether the app root is itself the top level of a Git work tree: an ordinary
// checkout or a linked worktree. Checked before every fetch, version read and
// merge. Setting cwd does not establish ownership, because git searches parent
// directories; the ceiling above stops that, and comparing canonical paths also
// rejects a repository whose top level is anywhere but the app root.
export async function isOwnCheckout({ git = defaultGit, appRoot = APP_ROOT } = {}) {
  try {
    const top = await gitOut(git, ['rev-parse', '--show-toplevel']);
    return Boolean(top) && fs.realpathSync(top) === appRoot;
  } catch {
    return false;
  }
}

async function assertOwnCheckout(git, appRoot) {
  if (!(await isOwnCheckout({ git, appRoot }))) throw new NotACheckoutError();
}

// What this install is, read once at startup. `codeVersion` is the identity
// sessions record at launch and the board reloads on: a validated checkout's
// HEAD commit, otherwise the package version (a Homebrew keg, an unpacked
// release). Never an enclosing repository's commit.
export async function readInstall({ git = defaultGit, appRoot = APP_ROOT, packageVersion = VERSION } = {}) {
  if (!(await isOwnCheckout({ git, appRoot }))) return { checkout: false, codeVersion: packageVersion };
  try {
    return { checkout: true, codeVersion: await gitOut(git, ['rev-parse', 'HEAD']) };
  } catch {
    return { checkout: true, codeVersion: null };
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

export async function checkForUpdate({ git = defaultGit, appRoot = APP_ROOT } = {}) {
  await assertOwnCheckout(git, appRoot);
  await git(['fetch', '--quiet', UPDATE_REMOTE, UPDATE_BRANCH]);
  return inspect(git);
}

export async function applyUpdate({ git = defaultGit, appRoot = APP_ROOT, beforeMerge = () => {} } = {}) {
  const status = await checkForUpdate({ git, appRoot });
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
