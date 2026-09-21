import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertAllowedUrl, cloneTo, readHead, lsRemoteHead, lockDependencies, npmCi, readDeclaration,
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

test('a missing package-lock.json refuses distinguishably', () => {
  const dir = tmpdir();
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

test('npmCi installs into the extension dir with scripts off and dev omitted', async () => {
  const npm = fakeRunner();
  const out = await npmCi('/ext/clone', { npm: npm.run });
  assert.deepEqual(npm.calls[0].args, ['ci', '--ignore-scripts', '--omit=dev']);
  assert.equal(npm.calls[0].opts.cwd, '/ext/clone');
  assert.ok(!('shell' in npm.calls[0].opts));
  assert.equal(out, path.join('/ext/clone', 'node_modules'));
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
    id: 'notes', label: 'Notes', description: 'Keeps notes.', author: 'A Colleague', homepage: 'https://example.invalid', requires: ['tasks:read'],
  });

  // Absent prose normalises to '' rather than undefined: every consumer renders
  // it through textContent, where undefined would print as "undefined".
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ wranglerExtension: { id: 'notes', label: 'Notes' } }));
  assert.deepEqual(readDeclaration(dir), { id: 'notes', label: 'Notes', description: '', author: '', homepage: '', requires: [] });
});
