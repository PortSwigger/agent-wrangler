import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'scripts', 'server', 'node_modules/.bin', 'home', 'logs', 'brew node/bin']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const file of ['bin/agent-wrangler', 'scripts/wrangler-start.sh', 'scripts/sync-deps.sh', 'scripts/update-rollback.sh', 'scripts/trim-service-logs.sh', 'scripts/launchd-process-type.sh', 'scripts/setup-locale.sh']) {
    fs.copyFileSync(path.join(sourceRoot, file), path.join(root, file));
  }
  const node = path.join(root, 'brew node/bin/node');
  fs.symlinkSync(process.execPath, node);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const env = {
    HOME: path.join(root, 'home'),
    PATH: '/usr/bin:/bin',
    AW_NODE: node,
    AW_LOG_DIR: path.join(root, 'logs'),
    AW_LOG_MAX_BYTES: '256',
  };
  return { root, env };
}

function run(root, env, file = 'bin/agent-wrangler', cwd = root) {
  return spawnSync(path.join(root, file), [], {
    cwd, env, encoding: 'utf8', timeout: 10000,
  });
}

// A host Node on the bare PATH (distro Node in /usr/bin) wins over the appended
// AW_NODE fallback, which is the intended precedence but leaves nothing to test.
const bareNode = ['/usr/bin', '/bin'].find(dir => fs.existsSync(path.join(dir, 'node')));

test('AW_NODE supplies Node to child tools on a bare service PATH', {
  skip: bareNode && `${bareNode}/node shadows the AW_NODE fallback`,
}, t => {
  const { root, env } = fixture(t);
  fs.writeFileSync(path.join(root, 'node_modules/.bin/devcontainer'),
    '#!/usr/bin/env node\nconsole.log(process.execPath);\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), `
    import { spawnSync } from 'node:child_process';
    const child = spawnSync('devcontainer', ['--version'], { encoding: 'utf8' });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    process.exit(child.status ?? 1);
  `);
  const result = run(root, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fs.realpathSync(process.execPath));
});

test('AW_NODE fallback preserves the Node already on the user PATH', t => {
  const { root, env } = fixture(t);
  const userBin = path.join(root, 'user-bin');
  fs.mkdirSync(userBin);
  fs.writeFileSync(path.join(userBin, 'node'), '#!/bin/sh\necho user-node\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), `
    import { execFileSync } from 'node:child_process';
    process.stdout.write(execFileSync('node', ['--version'], { encoding: 'utf8' }));
  `);
  const result = run(root, { ...env, PATH: `${userBin}:${env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'user-node');
});

function oversizedLogs(root) {
  return ['wrangler.log', 'wrangler.err'].map(name => {
    const file = path.join(root, 'logs', name);
    fs.writeFileSync(file, 'old history\n'.repeat(100) + 'recent tail\n');
    return { file, ino: fs.statSync(file).ino };
  });
}

function assertTrimmed(logs) {
  for (const { file, ino } of logs) {
    assert.equal(fs.statSync(file).ino, ino, 'preserve the supervisor log inode');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(text) < 512, 'keep a bounded tail and trim marker');
    assert.match(text, /recent tail/);
    assert.equal(text.match(/log trimmed at startup/g)?.length, 1, 'trim once per start');
  }
}

test('checkout service trims logs even when npm ci fails and does not start the server', t => {
  const { root, env } = fixture(t);
  const logs = oversizedLogs(root);
  fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\necho dependency-sync-failed >&2\nexit 42\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log("server-started");');
  const result = run(root, { ...env, PATH: `${root}/bin:${env.PATH}` }, 'scripts/wrangler-start.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /dependency-sync-failed/);
  assert.doesNotMatch(result.stdout, /server-started/);
  assertTrimmed(logs);
});

test('checkout service trims logs once before handing off to the launcher', t => {
  const { root, env } = fixture(t);
  const logs = oversizedLogs(root);
  fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log("server-started");');
  const result = run(root, { ...env, PATH: `${root}/bin:${env.PATH}` }, 'scripts/wrangler-start.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /server-started/);
  assertTrimmed(logs);
});

// AW_GIT_UPDATES grants the board's updater permission to apply, and only this
// start path earns it: rollback and dependency sync run before the launcher. A
// supervised bare launcher (a Homebrew service) is restartable but never gets it.
test('checkout service, and only it, grants Git updates after rollback and sync', t => {
  const { root, env } = fixture(t);
  fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log(JSON.stringify({ s: process.env.AW_SUPERVISED, g: process.env.AW_GIT_UPDATES }));');
  const service = run(root, { ...env, PATH: `${root}/bin:${env.PATH}` }, 'scripts/wrangler-start.sh');
  assert.equal(service.status, 0, service.stderr);
  assert.deepEqual(JSON.parse(service.stdout.trim().split('\n').pop()), { s: '1', g: '1' });
  const bare = run(root, { ...env, AW_SUPERVISED: '1' });
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(JSON.parse(bare.stdout.trim()), { s: '1' });
});

// launchd runs a plist with no ProcessType as a throttled background daemon, and
// every session inherits that. The checkout service gives its own plist (named
// after XPC_SERVICE_NAME, the label launchd exports) ProcessType Interactive,
// leaving the rest of the file as it was. plutil is macOS-only.
const plutilSkip = process.platform !== 'darwin' && 'plutil is macOS-only';
const templatePath = path.join(sourceRoot, 'scripts/net.portswigger.agent-wrangler.plist.example');
const processTypeBlock = /\n\n *<!--[^\n]*-->\n *<key>ProcessType<\/key>\n *<string>Interactive<\/string>/;
const olderTemplate = fs.readFileSync(templatePath, 'utf8').replace(processTypeBlock, '');
const processType = file => spawnSync('plutil', ['-extract', 'ProcessType', 'raw', file], { encoding: 'utf8' }).stdout.trim();

function serviceWithPlist(t, text) {
  const { root, env } = fixture(t);
  fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log("server-started");');
  const plist = path.join(env.HOME, 'Library/LaunchAgents/test.agent-wrangler.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, text);
  const start = (extra = {}) => {
    const result = run(root, { ...env, PATH: `${root}/bin:${env.PATH}`, XPC_SERVICE_NAME: 'test.agent-wrangler', ...extra }, 'scripts/wrangler-start.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /server-started/);
    return result;
  };
  return { plist, start };
}

test('plist template runs the service as an Interactive launchd job', { skip: plutilSkip }, () => {
  assert.equal(processType(templatePath), 'Interactive');
  assert.doesNotMatch(olderTemplate, /ProcessType/);
});

test('checkout service adds ProcessType Interactive to its own launchd plist, once', { skip: plutilSkip }, t => {
  const { plist, start } = serviceWithPlist(t, olderTemplate);
  const first = start();
  assert.match(first.stdout, /added ProcessType Interactive to \S+\/test\.agent-wrangler\.plist; launchd applies it from your next login/);
  assert.equal(processType(plist), 'Interactive');
  const added = fs.readFileSync(plist, 'utf8');
  assert.equal(added.replace(processTypeBlock, ''), olderTemplate, 'only the key and its comment are added');
  const second = start();
  assert.doesNotMatch(second.stdout + second.stderr, /ProcessType/);
  assert.equal(fs.readFileSync(plist, 'utf8'), added);
});

const leftAlone = [
  { name: 'one that sets its own ProcessType', text: () => fs.readFileSync(templatePath, 'utf8').replace('<string>Interactive</string>', '<string>Standard</string>') },
  { name: 'a package-managed install', env: { AW_INSTALL_MANAGER: 'homebrew' } },
  { name: 'a start outside launchd', env: { XPC_SERVICE_NAME: '' } },
  { name: 'one it cannot write', mode: 0o444, warns: true, skip: process.getuid?.() === 0 && 'root can write anything' },
  {
    name: 'a binary plist it cannot edit as text',
    warns: true,
    text: () => spawnSync('plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: olderTemplate }).stdout,
  },
];

for (const { name, text = () => olderTemplate, env: extra, mode, warns = false, skip } of leftAlone) {
  test(`checkout service leaves a launchd plist alone: ${name}`, { skip: plutilSkip || skip }, t => {
    const before = text();
    const { plist, start } = serviceWithPlist(t, before);
    if (mode) fs.chmodSync(plist, mode);
    const result = start(extra);
    assert.deepEqual(fs.readFileSync(plist), Buffer.from(before));
    assert.doesNotMatch(result.stdout, /added ProcessType/);
    if (warns) assert.match(result.stderr, /test\.agent-wrangler\.plist sets no ProcessType, so launchd runs this service as a background daemon/);
    else assert.doesNotMatch(result.stderr, /ProcessType/);
  });
}

for (const supervised of [false, true]) {
  test(`direct launcher ${supervised ? 'trims supervised' : 'preserves interactive'} logs`, t => {
    const { root, env } = fixture(t);
    const logs = oversizedLogs(root);
    fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log("server-started");');
    const result = run(root, { ...env, ...(supervised ? { AW_SUPERVISED: '1' } : {}) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /server-started/);
    if (supervised) assertTrimmed(logs);
    else for (const { file } of logs) assert.ok(fs.statSync(file).size > 1000);
  });
}

test('launcher appends the sbin dirs a bare supervisor PATH omits', t => {
  const { root, env } = fixture(t);
  fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log(process.env.PATH);');
  const result = run(root, env);
  assert.equal(result.status, 0, result.stderr);
  const dirs = result.stdout.trim().split(':');
  assert.deepEqual(dirs.slice(0, 2), ['/usr/bin', '/bin'], 'system dirs keep precedence');
  assert.ok(dirs.includes('/usr/sbin') && dirs.includes('/sbin'), result.stdout);
});

// The tmux server keeps the launcher's PATH, so the node_modules/.bin entry
// follows AW_INSTALL_ROOT on the server's terms (server/install-root.js): only
// an absolute path with no `.` or `..` segment that is this app, and never in a
// dev instance. The value goes into PATH exactly as checked.
//
// The case flip is in the fixture's own name, a real directory. Flipping the
// first letter of the path would hit macOS's /var, a symlink, where comparing
// `pwd -P` strings (the wrong check, since it keeps the typed case) also passes.
function caseFlipped(p) {
  const base = path.basename(p).replace(/[a-z]/i, ch => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
  return path.join(path.dirname(p), base);
}

const binRootCases = [
  { name: 'unset', installRoot: () => undefined, expect: 'root' },
  { name: 'a symlink to the app', installRoot: ({ link }) => link, expect: 'link' },
  { name: 'a symlink with a trailing slash', installRoot: ({ link }) => `${link}/`, expect: 'link' },
  // Relative: refused even though it reaches the app from the launcher's cwd.
  // CDPATH would also make a `cd` print the path and pick its own directory.
  {
    name: 'a relative path, with CDPATH set',
    installRoot: ({ link }) => path.basename(link),
    cwd: ({ link }) => path.dirname(link),
    env: ({ link }) => ({ CDPATH: path.dirname(link) }),
    expect: 'root',
  },
  // `<links>/opt/..` walks the filesystem through opt to the app's parent, so
  // `-ef` alone matches the app. Lexically (path.resolve, a logical `cd`) the
  // same value names <links>/<app name>, an unrelated directory that exists.
  { name: 'a `..` through the symlink', installRoot: ({ root, links }) => `${links}/opt/../${path.basename(root)}`, expect: 'root' },
  { name: 'a `.` segment', installRoot: ({ link }) => `${link}/.`, expect: 'root' },
  { name: 'a symlink in a dev instance', installRoot: ({ link }) => link, env: () => ({ AW_DEV: '1' }), expect: 'root' },
  { name: 'another directory', installRoot: ({ other }) => other, expect: 'root' },
  { name: 'a missing directory', installRoot: ({ root }) => path.join(root, 'missing'), expect: 'root' },
  {
    name: 'the app through a differently-cased path',
    installRoot: ({ root }) => caseFlipped(root),
    skip: root => !fs.existsSync(caseFlipped(root)) && 'case-sensitive filesystem',
    expect: 'flipped',
  },
];

for (const { name, installRoot, env: extra = () => ({}), cwd = ({ root }) => root, skip, expect } of binRootCases) {
  test(`launcher PATH takes node_modules/.bin from AW_INSTALL_ROOT: ${name}`, t => {
    const { root, env } = fixture(t);
    const reason = skip?.(root);
    if (reason) return t.skip(reason);
    const link = path.join(root, '..', `${path.basename(root)}-opt`);
    fs.symlinkSync(root, link);
    t.after(() => fs.rmSync(link, { force: true }));
    const links = path.join(root, '..', `${path.basename(root)}-links`);
    fs.mkdirSync(path.join(links, path.basename(root), 'node_modules/.bin'), { recursive: true });
    fs.symlinkSync(root, path.join(links, 'opt'));
    t.after(() => fs.rmSync(links, { recursive: true, force: true }));
    const other = path.join(root, 'home');
    const ctx = { root, link, links, other };
    const value = installRoot(ctx);
    fs.writeFileSync(path.join(root, 'server/cli.js'), 'console.log(process.env.PATH);');
    const result = run(root, { ...env, ...extra(ctx), ...(value ? { AW_INSTALL_ROOT: value } : {}) }, 'bin/agent-wrangler', cwd(ctx));
    assert.equal(result.status, 0, result.stderr);
    const want = { root, link, flipped: caseFlipped(root) }[expect];
    const entries = result.stdout.trim().split(':').filter(dir => dir.endsWith('node_modules/.bin'));
    assert.deepEqual(entries, [path.join(want, 'node_modules/.bin')]);
  });
}

// The launcher no longer touches tmux: a server's PATH is refreshed by the server
// itself, on its own socket (SessionManager.refreshTmuxPath). The old launcher
// looped over ${TMUX_TMPDIR}/tmux-UID/aw-* and only ran tmux for a real Unix
// socket, so the fixture binds one (no tmux needed) and a recording tmux on PATH
// proves the launcher stays out of it for every entry path, including the
// informational and error ones that never start a server, with the supervisor
// flag a tmux pane would have inherited.
async function listenOnAwSocket(t, root) {
  const dir = path.join(root, 'tmux', `tmux-${process.getuid()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sock = path.join(dir, 'aw-test');
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(sock, resolve));
  t.after(() => server.close());
  assert.ok(fs.statSync(sock).isSocket(), 'fixture must be a real Unix socket');
  return path.join(root, 'tmux');
}

const cases = [
  { name: 'server start', args: [], status: 0 },
  { name: '--help', args: ['--help'], status: 0 },
  { name: '--version', args: ['--version'], status: 0 },
  { name: 'an invalid argument', args: ['--no-such-flag'], status: 2 },
  { name: 'a dev start', args: [], env: { AW_DEV: '1' }, status: 0 },
];

for (const { name, args, env: extra = {}, status } of cases) {
  test(`supervised launcher leaves tmux untouched for ${name}`, async t => {
    const { root, env } = fixture(t);
    const tmuxTmp = await listenOnAwSocket(t, root);
    for (const file of ['cli.js', 'cli-args.js', 'version.js']) {
      fs.copyFileSync(path.join(sourceRoot, 'server', file), path.join(root, 'server', file));
    }
    fs.writeFileSync(path.join(root, 'server/index.js'), 'console.log("server-started");');
    const log = path.join(root, 'tmux.log');
    fs.writeFileSync(path.join(root, 'bin/tmux'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
    const result = spawnSync(path.join(root, 'bin/agent-wrangler'), args, {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...env, ...extra, PATH: `${root}/bin:${env.PATH}`, TMUX_TMPDIR: tmuxTmp, AW_SUPERVISED: '1' },
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(fs.existsSync(log), false, `launcher ran tmux: ${fs.existsSync(log) && fs.readFileSync(log, 'utf8')}`);
  });
}
