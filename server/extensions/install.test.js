import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertAllowedUrl, authHint, cloneTo, readHead, lsRemoteHead, commitsSince, countCommitsBehind, lockDependencies, npmCi, readDeclaration,
  MissingLockfileError, MissingDeclarationError,
} from './install.js';

// Every runner is injected, so nothing below spawns a process or touches the
// network: the fakes record their argv (and options) and that IS the assertion.
function fakeRunner(stdout = '') {
  const calls = [];
  const run = async (args, opts = {}) => { calls.push({ args, opts }); return { stdout, stderr: '' }; };
  return { run, calls };
}

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-install-test-'));
  process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('the URL allow-list refuses transports that are not a verifiable remote', () => {
  for (const bad of [
    'ext::sh -c id',
    'ext::sh',
    'file:///tmp/x',
    '/tmp/some/repo',
    './repo',
    'https://example.com/a;id',
    'https://example.com/a b',
    'git://example.com/x.git',
    'http://example.com/x.git',
    '',
  ]) {
    assert.throws(() => assertAllowedUrl(bad), /Refusing|required/, `expected refusal for ${JSON.stringify(bad)}`);
  }
  // The refusal echoes the offending URL back so the user can see what was rejected.
  assert.throws(() => assertAllowedUrl('file:///tmp/x'), /file:\/\/\/tmp\/x/);
});

test('the URL allow-list accepts https, ssh and the scp-like shorthand', () => {
  for (const ok of [
    'https://github.com/org/repo.git',
    'ssh://git@github.com/org/repo.git',
    'git@github.com:org/repo.git',
  ]) {
    assert.equal(assertAllowedUrl(ok), ok);
  }
});

test('cloneTo pins the transports off, passes -- and the URL as its own argv element, and never uses a shell', async () => {
  const git = fakeRunner();
  await cloneTo('https://github.com/org/repo.git', '/dest/dir', { git: git.run });
  assert.equal(git.calls.length, 1);
  const { args, opts } = git.calls[0];
  for (const flag of ['protocol.ext.allow=never', 'protocol.file.allow=never', '--depth', '1', '--no-recurse-submodules', '--no-local', '--']) {
    assert.ok(args.includes(flag), `clone argv missing ${flag}: ${args.join(' ')}`);
  }
  assert.equal(args[args.indexOf('--') + 1], 'https://github.com/org/repo.git');
  assert.equal(args.at(-1), '/dest/dir');
  assert.ok(!('shell' in opts), 'no shell option may be passed');
});

test('cloneTo screens the URL before git runs', async () => {
  const git = fakeRunner();
  await assert.rejects(() => cloneTo('ext::sh -c id', '/dest', { git: git.run }), /Refusing/);
  assert.deepEqual(git.calls, [], 'git must not be invoked for a refused URL');
});

test('readHead and lsRemoteHead parse a sha out of runner output', async () => {
  const head = fakeRunner('9af21b2c0ffee1234567890abcdef1234567890a\n');
  assert.equal(await readHead('/some/clone', { git: head.run }), '9af21b2c0ffee1234567890abcdef1234567890a');
  assert.equal(head.calls[0].opts.cwd, '/some/clone');
  assert.deepEqual(head.calls[0].args, ['rev-parse', 'HEAD']);

  const remote = fakeRunner('dfa4315deadbeef1234567890abcdef123456789\tHEAD\n');
  assert.equal(await lsRemoteHead('git@github.com:org/repo.git', { git: remote.run }), 'dfa4315deadbeef1234567890abcdef123456789');
  const args = remote.calls[0].args;
  assert.ok(args.includes('ls-remote') && args.includes('--'));
  assert.equal(args[args.indexOf('--') + 1], 'git@github.com:org/repo.git');

  const bad = fakeRunner('not a sha\n');
  await assert.rejects(() => readHead('/x', { git: bad.run }), /Could not parse a commit sha/);
  await assert.rejects(() => lsRemoteHead('file:///tmp/x', { git: bad.run }), /Refusing/);
});

test('a missing package-lock.json refuses distinguishably when dependencies are declared', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { left: '^1.0.0' } }));
  try {
    lockDependencies(dir);
    assert.fail('expected a refusal');
  } catch (err) {
    assert.ok(err instanceof MissingLockfileError);
    assert.equal(err.code, 'AW_NO_LOCKFILE');
    assert.match(err.message, /not installable/);
  }
});

test('lockDependencies flattens a v3 packages lockfile, skipping the root key', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'ext', version: '1.0.0', dependencies: { left: '^1.0.0' } },
      'node_modules/left': { version: '1.2.3' },
      'node_modules/left/node_modules/dep': { version: '4.5.6' },
      'node_modules/dep': { version: '4.5.6' },
      'node_modules/@scope/thing': { version: '0.1.0' },
      'node_modules/nover': {},
    },
  }));
  const out = lockDependencies(dir);
  assert.deepEqual(out.all, ['@scope/thing@0.1.0', 'dep@4.5.6', 'left@1.2.3']);
  assert.deepEqual(out.direct, ['left@1.2.3']);
  assert.equal(out.transitiveCount, 2);
});

test('lockDependencies walks a legacy v1 dependencies tree', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { alpha: '^1.0.0' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 1,
    dependencies: {
      alpha: { version: '1.0.0', dependencies: { beta: { version: '2.0.0' } } },
      gamma: { version: '3.0.0', dependencies: { beta: { version: '2.0.0' } } },
    },
  }));
  const out = lockDependencies(dir);
  assert.deepEqual(out.all, ['alpha@1.0.0', 'beta@2.0.0', 'gamma@3.0.0']);
  assert.deepEqual(out.direct, ['alpha@1.0.0']);
  assert.equal(out.transitiveCount, 2);
});

test('a missing package-lock.json is fine when no runtime dependencies are declared', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ext', dependencies: {}, devDependencies: { tap: '^1.0.0' } }));
  assert.deepEqual(lockDependencies(dir), { all: [], direct: [], transitiveCount: 0 });
});

test('a missing package-lock.json still refuses optional or peer dependencies, or an unreadable package.json', () => {
  for (const pkg of [{ optionalDependencies: { a: '1' } }, { peerDependencies: { a: '1' } }, { bundleDependencies: ['a'] }, null]) {
    const dir = tmpdir();
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    assert.throws(() => lockDependencies(dir), MissingLockfileError);
  }
});

test('npmCi skips npm entirely when there is no lockfile', async () => {
  const dir = tmpdir();
  const npm = fakeRunner();
  const out = await npmCi(dir, { npm: npm.run });
  assert.equal(npm.calls.length, 0);
  assert.equal(out, path.join(dir, 'node_modules'));
});

test('npmCi installs into the extension dir with scripts off and dev omitted', async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  const npm = fakeRunner();
  const out = await npmCi(dir, { npm: npm.run });
  assert.deepEqual(npm.calls[0].args, ['ci', '--ignore-scripts', '--omit=dev']);
  assert.equal(npm.calls[0].opts.cwd, dir);
  assert.ok(!('shell' in npm.calls[0].opts));
  assert.equal(out, path.join(dir, 'node_modules'));
});

test('readDeclaration reads the disclosure statically, without importing anything', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-decl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // An index.js that would throw if it were ever imported — the whole point is
  // that disclosing an install runs none of the extension's code.
  fs.writeFileSync(path.join(dir, 'index.js'), "throw new Error('imported');\n");

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  assert.throws(() => readDeclaration(dir), (err) => err instanceof MissingDeclarationError && err.code === 'AW_NO_DECLARATION');

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'Bad Id', label: 'x' } }));
  assert.throws(() => readDeclaration(dir), /wranglerExtension\.id must match/);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'notes' } }));
  assert.throws(() => readDeclaration(dir), /label must be a non-empty string/);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'notes', label: 'Notes', requires: 'tasks:read' } }));
  assert.throws(() => readDeclaration(dir), /requires must be an array/);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    wranglerExtension: { id: 'notes', label: 'Notes', description: 'Keeps notes.', author: 'A Colleague', homepage: 'https://example.invalid', requires: ['tasks:read'] },
  }));
  assert.deepEqual(readDeclaration(dir), {
    id: 'notes', label: 'Notes', description: 'Keeps notes.', author: 'A Colleague', homepage: 'https://example.invalid', requires: ['tasks:read'], range: null, earlyAdopterBranch: null,
  });

  // The declared host API range rides along for the pre-consent engines gate.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'notes', label: 'Notes', engines: { wranglerApi: '^9.0.0' } } }));
  assert.equal(readDeclaration(dir).range, '^9.0.0');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'notes', label: 'Notes', engines: { wranglerApi: 9 } } }));
  assert.throws(() => readDeclaration(dir), /engines\.wranglerApi must be a semver range string/);

  // Absent prose normalises to '' rather than undefined: every consumer renders
  // it through textContent, where undefined would print as "undefined".
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'notes', label: 'Notes' } }));
  assert.deepEqual(readDeclaration(dir), { id: 'notes', label: 'Notes', description: '', author: '', homepage: '', requires: [], range: null, earlyAdopterBranch: null });
});

test('commitsSince deepens the shallow clone and logs only what the update brings in', async () => {
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    if (args.includes('log')) return { stdout: `${'b'.repeat(40)}\tFix the thing\n${'c'.repeat(40)}\tAdd a tab\tto the panel\n` };
    return { stdout: '' };
  };
  const { commits, truncated } = await commitsSince('/clone', 'a'.repeat(40), { git });
  assert.equal(truncated, false);
  assert.deepEqual(commits, [{ sha: 'bbbbbbbb', subject: 'Fix the thing' }, { sha: 'cccccccc', subject: 'Add a tab\tto the panel' }]);
  assert.ok(calls[0].includes('protocol.file.allow=never') && calls[0].includes('--deepen=50'));
  assert.ok(calls.at(-1).includes(`${'a'.repeat(40)}..HEAD`));
});

test('commitsSince marks the list truncated when the installed commit is out of reach', async () => {
  const git = async (args) => {
    if (args.includes('fetch')) throw new Error('offline');
    if (args.includes('merge-base')) throw new Error('not an ancestor');
    return { stdout: `${'b'.repeat(40)}\tNewest\n` };
  };
  const { commits, truncated } = await commitsSince('/clone', 'a'.repeat(40), { git });
  assert.equal(truncated, true);
  assert.equal(commits.length, 1);
});

test('countCommitsBehind fetches the recorded origin into the clone and counts from the installed commit', async () => {
  const calls = [];
  const git = async (args, opts) => {
    calls.push({ args, opts });
    if (args.includes('rev-list')) return { stdout: '4\n' };
    return { stdout: '' };
  };
  const result = await countCommitsBehind('/installed', 'a'.repeat(40), 'https://github.com/org/repo.git', { git });
  assert.deepEqual(result, { commits: 4, capped: false });
  const fetch = calls[0].args;
  assert.ok(fetch.includes('protocol.ext.allow=never') && fetch.includes('--depth=50'));
  assert.equal(fetch[fetch.indexOf('--') + 1], 'https://github.com/org/repo.git');
  assert.ok(calls.every((c) => c.opts.cwd === '/installed'));
  assert.ok(calls.at(-1).args.includes(`${'a'.repeat(40)}..FETCH_HEAD`));
});

test('countCommitsBehind caps the count when the installed commit is out of reach', async () => {
  const git = async (args) => {
    if (args.includes('merge-base')) throw new Error('not an ancestor');
    if (args.includes('rev-list')) return { stdout: '50\n' };
    return { stdout: '' };
  };
  assert.deepEqual(await countCommitsBehind('/installed', 'a'.repeat(40), 'https://github.com/org/repo.git', { git }), { commits: 50, capped: true });
});

// What execFile rejects with when git exits non-zero: a long "Command failed"
// message with stderr appended, and stderr on its own.
function gitFailure(stderr) {
  return Object.assign(new Error(`Command failed: git clone -- url /dest\n${stderr}`), { code: 128, stderr });
}

test('authHint recognises git auth failures on github.com URLs', () => {
  for (const stderr of [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/org/repo.git/'",
    "remote: Repository not found.\nfatal: repository 'https://github.com/org/repo.git/' not found",
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
  ]) {
    assert.match(authHint('https://github.com/org/repo.git', gitFailure(stderr)) || '', /gh auth login.*gh auth setup-git/, stderr);
  }
  // The message alone is enough when stderr is not attached.
  assert.ok(authHint('https://github.com/org/repo', new Error('fatal: Authentication failed')));
});

test('authHint stays out of failures that are not GitHub auth', () => {
  const auth = gitFailure('fatal: Authentication failed');
  assert.equal(authHint('https://gitlab.example.com/org/repo.git', auth), null);
  assert.equal(authHint('https://notgithub.com/org/repo.git', auth), null);
  assert.equal(authHint('https://github.com/org/repo.git', gitFailure('fatal: unable to access: Could not resolve host: github.com')), null);
  assert.equal(authHint('https://github.com/org/repo.git', null), null);
});

test('authHint points an SSH URL at its https:// form rather than at keys', () => {
  const err = gitFailure('git@github.com: Permission denied (publickey).');
  for (const url of ['git@github.com:org/repo.git', 'ssh://git@github.com/org/repo.git']) {
    assert.match(authHint(url, err), /install from its https:\/\/ URL instead/);
  }
  assert.match(authHint('https://github.com/org/repo.git', err), /and try again\.$/);
});

test('a GitHub auth failure on clone, ls-remote or fetch carries the hint and git\'s own line', async () => {
  const stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
  const git = async () => { throw gitFailure(stderr); };
  const url = 'https://github.com/org/private.git';
  for (const call of [
    () => cloneTo(url, '/dest', { git }),
    () => cloneTo(url, '/dest', { git, branch: 'next' }),
    () => lsRemoteHead(url, { git }),
    () => countCommitsBehind('/installed', 'a'.repeat(40), url, { git }),
  ]) {
    await assert.rejects(call, (err) => {
      assert.equal(err.message, `Could not read ${url} (${stderr}). It may be a private repository: run gh auth login, then gh auth setup-git, and try again.`);
      assert.equal(err.cause.stderr, stderr);
      return true;
    });
  }
});

test('any other git failure is rethrown untouched', async () => {
  const original = gitFailure('fatal: unable to access: Could not resolve host: github.com');
  await assert.rejects(() => cloneTo('https://github.com/org/repo.git', '/dest', { git: async () => { throw original; } }), (err) => err === original);
});

test('countCommitsBehind refuses a disallowed origin before running git', async () => {
  let ran = 0;
  await assert.rejects(() => countCommitsBehind('/installed', 'a', 'ext::sh -c id', { git: async () => { ran += 1; return { stdout: '' }; } }), /Refusing/);
  assert.equal(ran, 0);
});

// ── early-adopter branch ────────────────────────────────────────────────────

// A git fake that answers ls-remote for the refs `remote` has, and records argv.
function remoteGit(remote) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args, opts });
    if (args.includes('ls-remote')) {
      const asked = args.slice(args.indexOf('--') + 2);
      return { stdout: asked.filter((r) => remote[r]).map((r) => `${remote[r]}\t${r}\n`).join('') };
    }
    if (args.includes('rev-list')) return { stdout: '3\n' };
    return { stdout: '' };
  };
  return { run, calls };
}
const URL = 'https://github.com/org/repo.git';
const HEAD_SHA = '1'.repeat(40);
const NEXT_SHA = '2'.repeat(40);

test('with no branch, clone, ls-remote and the commit count are exactly as before', async () => {
  const git = remoteGit({ HEAD: HEAD_SHA });
  await cloneTo(URL, '/dest', { git: git.run });
  assert.equal(await lsRemoteHead(URL, { git: git.run }), HEAD_SHA);
  await countCommitsBehind('/installed', 'a'.repeat(40), URL, { git: git.run });
  assert.equal(git.calls.length, 5, 'clone, ls-remote, fetch, merge-base, rev-list: no branch lookups');
  assert.ok(!git.calls[0].args.includes('--branch'));
  assert.deepEqual(git.calls[1].args.slice(-3), ['--', URL, 'HEAD']);
  assert.deepEqual(git.calls[2].args.slice(-3), ['--', URL, 'HEAD']);
});

test('an EA branch the remote has is cloned, reported and fetched to count', async () => {
  const git = remoteGit({ HEAD: HEAD_SHA, 'refs/heads/next': NEXT_SHA });
  await cloneTo(URL, '/dest', { git: git.run, branch: 'next' });
  const clone = git.calls.find((c) => c.args.includes('clone')).args;
  assert.equal(clone[clone.indexOf('--branch') + 1], 'next');
  assert.ok(clone.indexOf('--branch') < clone.indexOf('--'), 'the branch is an option before --');
  assert.equal(await lsRemoteHead(URL, { git: git.run, branch: 'next' }), NEXT_SHA);
  git.calls.length = 0;
  assert.deepEqual(await countCommitsBehind('/installed', 'a'.repeat(40), URL, { git: git.run, branch: 'next' }), { commits: 3, capped: false });
  const fetch = git.calls.find((c) => c.args.includes('fetch')).args;
  assert.equal(fetch.at(-1), 'refs/heads/next');
});

test('an EA branch missing on the remote falls back to HEAD everywhere', async () => {
  const git = remoteGit({ HEAD: HEAD_SHA });
  await cloneTo(URL, '/dest', { git: git.run, branch: 'next' });
  assert.ok(!git.calls.find((c) => c.args.includes('clone')).args.includes('--branch'));
  assert.equal(await lsRemoteHead(URL, { git: git.run, branch: 'next' }), HEAD_SHA);
  git.calls.length = 0;
  await countCommitsBehind('/installed', 'a'.repeat(40), URL, { git: git.run, branch: 'next' });
  assert.equal(git.calls.find((c) => c.args.includes('fetch')).args.at(-1), 'HEAD');
});

test('a branch that is not a plain git branch name never reaches git', async () => {
  for (const bad of ['--upload-pack=touch x', 'a..b', 'a b', 'x.lock']) {
    const git = remoteGit({ HEAD: HEAD_SHA });
    await assert.rejects(() => cloneTo(URL, '/dest', { git: git.run, branch: bad }), /not a plain git branch name/);
    await assert.rejects(() => lsRemoteHead(URL, { git: git.run, branch: bad }), /not a plain git branch name/);
    await assert.rejects(() => countCommitsBehind('/i', 'a', URL, { git: git.run, branch: bad }), /not a plain git branch name/);
    assert.deepEqual(git.calls, []);
  }
});

test('readDeclaration carries earlyAdopter.branch and refuses a malformed one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-decl-ea-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (ea) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'notes', label: 'Notes', earlyAdopter: ea } }));
  write({ branch: 'next' });
  assert.equal(readDeclaration(dir).earlyAdopterBranch, 'next');
  for (const bad of ['next', { branch: '-x' }, { branch: '' }, ['next']]) {
    write(bad);
    assert.throws(() => readDeclaration(dir), /earlyAdopter must be \{ branch \}/);
  }
});
