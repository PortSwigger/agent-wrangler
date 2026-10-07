import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkForUpdate, applyUpdate, blockedReason, readInstall, isOwnCheckout, gitFor, checkoutGitEnv, NotACheckoutError } from './self-update.js';

// The fake's app root: isOwnCheckout compares canonical paths, so it must exist.
const ROOT = fs.realpathSync(os.tmpdir());

function fakeGit({ branch = 'main', status = '', counts = '0\t2', log = 'aaa1111\tFirst\nbbb2222\tSecond: with\ttab', head = 'h0', toplevel = ROOT, fail = {} } = {}) {
  const calls = [];
  let current = head;
  const git = async (args) => {
    calls.push(args.join(' '));
    const [cmd] = args;
    if (fail[cmd]) throw new Error(fail[cmd]);
    if (cmd === 'fetch') return { stdout: '' };
    if (cmd === 'status') return { stdout: status };
    if (cmd === 'rev-list') return { stdout: counts };
    if (cmd === 'log') return { stdout: log };
    if (cmd === 'merge') { current = 'h1'; return { stdout: '' }; }
    if (cmd === 'rev-parse') {
      if (args[1] === '--show-toplevel') return { stdout: `${toplevel}\n` };
      if (args[1] === '--abbrev-ref') return { stdout: `${branch}\n` };
      if (args[1] === 'HEAD') return { stdout: `${current}\n` };
      return { stdout: 'r1\n' };
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}

test('a check confirms ownership, then fetches main and lists the commits it is behind', async () => {
  const { git, calls } = fakeGit();
  const status = await checkForUpdate({ git, appRoot: ROOT });
  assert.equal(calls[0], 'rev-parse --show-toplevel');
  assert.equal(calls[1], 'fetch --quiet origin main');
  assert.equal(status.behind, 2);
  assert.equal(status.head, 'h0');
  assert.equal(status.remote, 'r1');
  assert.equal(status.blocked, null);
  assert.deepEqual(status.commits, [{ sha: 'aaa1111', subject: 'First' }, { sha: 'bbb2222', subject: 'Second: with\ttab' }]);
});

test('an up-to-date checkout lists no commits', async () => {
  const { git, calls } = fakeGit({ counts: '0\t0' });
  const status = await checkForUpdate({ git, appRoot: ROOT });
  assert.equal(status.behind, 0);
  assert.deepEqual(status.commits, []);
  assert.ok(!calls.some((c) => c.startsWith('log')));
});

test('an update is blocked off main, with local changes, or with local commits', () => {
  assert.match(blockedReason({ branch: 'feature', dirty: false, ahead: 0 }), /on "feature"/);
  assert.match(blockedReason({ branch: 'main', dirty: true, ahead: 0 }), /uncommitted changes/);
  assert.match(blockedReason({ branch: 'main', dirty: false, ahead: 1 }), /1 local commit not/);
  assert.equal(blockedReason({ branch: 'main', dirty: false, ahead: 0 }), null);
});

test('apply fast-forwards and reports the new head', async () => {
  const { git, calls } = fakeGit();
  const result = await applyUpdate({ git, appRoot: ROOT });
  assert.ok(calls.includes('merge --ff-only --quiet origin/main'));
  assert.equal(result.updated, true);
  assert.equal(result.head, 'h1');
});

test('apply refuses a blocked checkout without merging', async () => {
  const { git, calls } = fakeGit({ status: ' M server/index.js' });
  await assert.rejects(() => applyUpdate({ git, appRoot: ROOT }), /uncommitted changes/);
  assert.ok(!calls.some((c) => c.startsWith('merge')));
});

test('apply with nothing new does not merge', async () => {
  const { git, calls } = fakeGit({ counts: '0\t0' });
  const result = await applyUpdate({ git, appRoot: ROOT });
  assert.equal(result.updated, false);
  assert.ok(!calls.some((c) => c.startsWith('merge')));
});

test('a checkout reports its HEAD as the code version; anything else its package version', async () => {
  assert.deepEqual(await readInstall({ git: fakeGit().git, appRoot: ROOT, packageVersion: '9.9.9' }), { checkout: true, codeVersion: 'h0' });
  const outside = fakeGit({ fail: { 'rev-parse': 'not a git repository' } });
  assert.deepEqual(await readInstall({ git: outside.git, appRoot: ROOT, packageVersion: '9.9.9' }), { checkout: false, codeVersion: '9.9.9' });
  const enclosing = fakeGit({ toplevel: path.dirname(ROOT) });
  assert.deepEqual(await readInstall({ git: enclosing.git, appRoot: ROOT, packageVersion: '9.9.9' }), { checkout: false, codeVersion: '9.9.9' });
  assert.deepEqual(enclosing.calls, ['rev-parse --show-toplevel'], 'never reads the enclosing repository HEAD');
});

test('a check or apply in a repository it does not own is refused before any fetch', async () => {
  const { git, calls } = fakeGit({ toplevel: path.dirname(ROOT) });
  await assert.rejects(() => checkForUpdate({ git, appRoot: ROOT }), NotACheckoutError);
  await assert.rejects(() => applyUpdate({ git, appRoot: ROOT }), NotACheckoutError);
  assert.deepEqual(calls, ['rev-parse --show-toplevel', 'rev-parse --show-toplevel']);
});

test('the git env drops repository overrides and stops discovery at the app root', () => {
  const env = checkoutGitEnv({ PATH: '/bin', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_INDEX_FILE: 'i', GIT_COMMON_DIR: 'c', GIT_SSH_COMMAND: 'ssh -i k' }, '/opt/homebrew/Cellar/agent-wrangler/0.2.0/libexec');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_INDEX_FILE, undefined);
  assert.equal(env.GIT_COMMON_DIR, undefined);
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i k', 'transport settings still apply to the fetch');
  assert.equal(env.GIT_CEILING_DIRECTORIES, '/opt/homebrew/Cellar/agent-wrangler/0.2.0');
  assert.equal(env.PATH, '/bin');
});

// --- Real repositories. Each fixture is a throwaway tree under the OS temp dir.

const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...checkoutGitEnv(process.env, '/'), ...GIT_ID, GIT_CEILING_DIRECTORIES: '' } }).trim();
}

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-own-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function commit(repo, file, text) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  sh(repo, 'add', '-A');
  sh(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `edit ${file}`);
  return sh(repo, 'rev-parse', 'HEAD');
}

// A repository on main with an origin one commit ahead: the shape the updater
// would happily fast-forward if it ever reached it.
function repoBehindOrigin(dir, name) {
  const origin = path.join(dir, `${name}-origin.git`);
  const repo = path.join(dir, name);
  sh(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(dir, 'clone', '-q', origin, repo);
  commit(repo, 'README', 'one\n');
  sh(repo, 'push', '-q', 'origin', 'main');
  const ahead = path.join(dir, `${name}-ahead`);
  sh(dir, 'clone', '-q', origin, ahead);
  commit(ahead, 'README', 'two\n');
  sh(ahead, 'push', '-q', 'origin', 'main');
  return repo;
}

function repoState(repo) {
  const gitDir = path.join(repo, '.git');
  const read = (f) => (fs.existsSync(path.join(gitDir, f)) ? fs.readFileSync(path.join(gitDir, f), 'utf8') : null);
  return { head: sh(repo, 'rev-parse', 'HEAD'), fetchHead: read('FETCH_HEAD'), reflog: read('logs/HEAD'), remoteRef: sh(repo, 'rev-parse', 'origin/main') };
}

function appIn(parent, name = 'app') {
  const app = path.join(parent, name);
  fs.mkdirSync(path.join(app, 'server'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"version":"0.1.0"}');
  return fs.realpathSync(app);
}

const inApp = (appRoot) => ({ git: gitFor(appRoot), appRoot, packageVersion: '0.1.0' });

test('real git: an app inside an unrelated repository never touches it', async (t) => {
  const dir = tmp(t);
  const parent = repoBehindOrigin(dir, 'parent');
  const app = appIn(parent);
  const before = repoState(parent);
  assert.equal(sh(app, 'rev-parse', '--show-toplevel'), parent, 'plain git does resolve to the parent: the bug');

  assert.deepEqual(await readInstall(inApp(app)), { checkout: false, codeVersion: '0.1.0' });
  await assert.rejects(() => checkForUpdate(inApp(app)), NotACheckoutError);
  await assert.rejects(() => applyUpdate(inApp(app)), NotACheckoutError);
  assert.deepEqual(repoState(parent), before, 'no fetch, no merge, no reflog entry');
});

test('real git: an install outside any repository is not a checkout', async (t) => {
  const app = appIn(tmp(t));
  assert.deepEqual(await readInstall(inApp(app)), { checkout: false, codeVersion: '0.1.0' });
  await assert.rejects(() => checkForUpdate(inApp(app)), NotACheckoutError);
});

test('real git: an ordinary checkout is its own and updates', async (t) => {
  const repo = repoBehindOrigin(tmp(t), 'wrangler');
  const install = await readInstall(inApp(repo));
  assert.deepEqual(install, { checkout: true, codeVersion: sh(repo, 'rev-parse', 'HEAD') });
  const status = await checkForUpdate(inApp(repo));
  assert.equal(status.behind, 1);
  const result = await applyUpdate(inApp(repo));
  assert.equal(result.updated, true);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), status.remote);
});

test('real git: a linked worktree is its own checkout', async (t) => {
  const dir = tmp(t);
  const repo = repoBehindOrigin(dir, 'wrangler');
  const wt = path.join(dir, 'wt');
  sh(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  assert.equal(await isOwnCheckout({ git: gitFor(wt), appRoot: wt }), true);
  const status = await checkForUpdate(inApp(wt));
  assert.match(status.blocked, /on "feature"/, 'ownership passes; the existing branch rule still applies');
});

test('real git: a symlinked install path resolves to what it points at', async (t) => {
  const dir = tmp(t);
  const repo = repoBehindOrigin(dir, 'wrangler');
  const viaLink = path.join(dir, 'opt-link');
  fs.symlinkSync(repo, viaLink);
  const appRoot = fs.realpathSync(viaLink);
  assert.equal(await isOwnCheckout({ git: gitFor(appRoot), appRoot }), true);

  // Homebrew's shape: a stable link to a versioned keg inside some other repository.
  const parent = repoBehindOrigin(dir, 'homebrew');
  const keg = appIn(path.join(parent, 'Cellar', 'agent-wrangler'), '0.2.0');
  const optLink = path.join(dir, 'opt-agent-wrangler');
  fs.symlinkSync(keg, optLink);
  const kegRoot = fs.realpathSync(optLink);
  assert.equal(await isOwnCheckout({ git: gitFor(kegRoot), appRoot: kegRoot }), false);
});

test('real git: inherited GIT_DIR / GIT_WORK_TREE pointing at another repository are ignored', async (t) => {
  const dir = tmp(t);
  const other = repoBehindOrigin(dir, 'other');
  const before = repoState(other);
  const app = appIn(dir, 'packaged');
  const repo = repoBehindOrigin(dir, 'wrangler');
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(other, '.git');
  process.env.GIT_WORK_TREE = other;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  assert.deepEqual(await readInstall(inApp(app)), { checkout: false, codeVersion: '0.1.0' });
  await assert.rejects(() => applyUpdate(inApp(app)), NotACheckoutError);
  assert.deepEqual(await readInstall(inApp(repo)), { checkout: true, codeVersion: sh(repo, 'rev-parse', 'HEAD') });
  assert.deepEqual(repoState(other), before);
});
