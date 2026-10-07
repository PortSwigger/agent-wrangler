import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionManager } from './session-manager.js';
import { INSTALL_SCOPED_ENV } from './install-env.js';

const FRESH = '/fresh/bin:/usr/bin';

function recordingManager(socket = 'aw-own', { fail = false } = {}) {
  const sm = new SessionManager();
  sm.socket = socket;
  sm.calls = [];
  sm._tmux = async (sock, args) => {
    sm.calls.push([sock, ...args]);
    if (fail) throw new Error('no server running on /tmp/tmux-0/aw-own');
    return { stdout: '' };
  };
  return sm;
}

test('a supervised non-dev server sets PATH on its own socket only', async () => {
  const sm = recordingManager();
  assert.equal(await sm.refreshTmuxPath({ supervised: true, env: { PATH: FRESH } }), true);
  assert.deepEqual(sm.calls, [['aw-own', 'set-environment', '-g', 'PATH', FRESH]]);
});

// A pane that predates the env-inheritance rule still carries AW_SUPERVISED, so
// a dev instance started from one is supervised as far as its capture goes;
// AW_DEV must still leave tmux alone. (Parsing "exactly 1" is install-env's job.)
for (const [label, opts] of [
  ['unsupervised', { supervised: false, env: { PATH: FRESH } }],
  ['inherited supervision with AW_DEV=1', { supervised: true, env: { AW_DEV: '1', PATH: FRESH } }],
  ['inherited supervision with AW_DEV=true', { supervised: true, env: { AW_DEV: 'true', PATH: FRESH } }],
  ['no PATH to publish', { supervised: true, env: {} }],
]) {
  test(`PATH refresh is skipped: ${label}`, async () => {
    const sm = recordingManager();
    assert.equal(await sm.refreshTmuxPath(opts), false);
    assert.deepEqual(sm.calls, []);
  });
}

test('PATH refresh never targets the default socket before init resolves one', async () => {
  const sm = recordingManager('');
  assert.equal(await sm.refreshTmuxPath({ supervised: true, env: { PATH: FRESH } }), false);
  assert.deepEqual(sm.calls, []);
});

test('a missing tmux server is harmless', async () => {
  const sm = recordingManager('aw-own', { fail: true });
  assert.equal(await sm.refreshTmuxPath({ supervised: true, env: { PATH: FRESH } }), false);
  assert.equal(sm.calls.length, 1);
});

const tmuxBin = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();

// Real tmux on private sockets under a private TMUX_TMPDIR. If the sandbox stops
// tmux servers from staying up the new-session assertion fails, which is an
// environment limit and not a refresh bug. The pane command is absolute because
// the servers start with a stale PATH that cannot find `sleep`.
test('real tmux: refresh updates the owned server only, never an unrelated one or a missing one', {
  skip: !tmuxBin && 'tmux not installed',
}, async (t) => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-'));
  const priorTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = tmpdir;
  const tmux = (sock, ...args) => spawnSync(tmuxBin, ['-L', sock, ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: '/stale/bin' },
  });
  const socks = ['aw-own', 'aw-other', 'default'];
  t.after(() => {
    for (const sock of socks) tmux(sock, 'kill-server');
    if (priorTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = priorTmpdir;
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
  for (const sock of socks) assert.equal(tmux(sock, '-f', '/dev/null', 'new-session', '-d', '/bin/sleep 60').status, 0, `start ${sock}`);
  const pathOn = (sock) => tmux(sock, 'show-environment', '-g', 'PATH').stdout.trim();
  for (const sock of socks) assert.equal(pathOn(sock), 'PATH=/stale/bin');

  const sm = new SessionManager();
  sm.tmuxBin = tmuxBin;
  sm.socket = 'aw-own';
  assert.equal(await sm.refreshTmuxPath({ supervised: true, env: { PATH: FRESH } }), true);
  assert.equal(pathOn('aw-own'), `PATH=${FRESH}`);
  assert.equal(pathOn('aw-other'), 'PATH=/stale/bin');
  assert.equal(pathOn('default'), 'PATH=/stale/bin');

  // Dev instance with the supervisor flag inherited: nothing changes.
  assert.equal(await sm.refreshTmuxPath({ supervised: true, env: { AW_DEV: '1', PATH: '/dev/checkout/bin' } }), false);
  assert.equal(pathOn('aw-own'), `PATH=${FRESH}`);

  // A supervised restart refreshes the already-running owned server again.
  assert.equal(await sm.refreshTmuxPath({ supervised: true, env: { PATH: '/newer/bin' } }), true);
  assert.equal(pathOn('aw-own'), 'PATH=/newer/bin');

  // No server on the socket: harmless, and it must not start one.
  const missing = new SessionManager();
  missing.tmuxBin = tmuxBin;
  missing.socket = 'aw-missing';
  assert.equal(await missing.refreshTmuxPath({ supervised: true, env: { PATH: FRESH } }), false);
  const socketDir = path.join(tmpdir, `tmux-${process.getuid()}`);
  assert.equal(fs.existsSync(path.join(socketDir, 'aw-missing')), false);
});

test('install-scoped signals are unset on the own socket in one tmux call', async () => {
  const sm = recordingManager();
  assert.equal(await sm.clearInstallEnv(['AW_SUPERVISED', 'AW_NODE']), true);
  assert.deepEqual(sm.calls, [['aw-own', 'set-environment', '-g', '-u', 'AW_SUPERVISED', ';', 'set-environment', '-g', '-u', 'AW_NODE']]);
  assert.equal(await recordingManager('').clearInstallEnv(), false, 'never the default socket');
  assert.equal(await recordingManager('aw-own', { fail: true }).clearInstallEnv(), false, 'no server is harmless');
});

// The already-running case: a tmux server started by an older wrangler (or any
// process with the board's env) holds the signals in its global environment and
// hands them to every new pane. After the clear, a new pane sees none of them,
// a pane that already existed keeps its own copy, and other sockets are untouched.
test('real tmux: a running server stops handing install signals to new panes', {
  skip: !tmuxBin && 'tmux not installed',
}, async (t) => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'awe-'));
  const signals = Object.fromEntries(INSTALL_SCOPED_ENV.map((n) => [n, n === 'AW_SUPERVISED' || n === 'AW_GIT_UPDATES' ? '1' : `/x/${n}`]));
  const env = { ...process.env, ...signals, TMUX_TMPDIR: tmpdir };
  const tmux = (sock, ...args) => spawnSync(tmuxBin, ['-L', sock, ...args], { encoding: 'utf8', env });
  t.after(() => {
    for (const sock of ['aw-own', 'aw-other']) tmux(sock, 'kill-server');
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
  const dump = (sock, name) => {
    const out = path.join(tmpdir, `${sock}-${name}.env`);
    assert.equal(tmux(sock, 'new-session', '-d', '-s', name, `/usr/bin/env > ${out}; /bin/sleep 60`).status, 0);
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) spawnSync('/bin/sleep', ['0.05']);
    spawnSync('/bin/sleep', ['0.05']);
    return fs.readFileSync(out, 'utf8');
  };
  const leaked = (text) => INSTALL_SCOPED_ENV.filter((n) => new RegExp(`^${n}=`, 'm').test(text));
  for (const sock of ['aw-own', 'aw-other']) assert.equal(tmux(sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'old', '/bin/sleep 60').status, 0);
  assert.deepEqual(leaked(dump('aw-own', 'before')), INSTALL_SCOPED_ENV, 'the server inherited every signal');

  const priorTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = tmpdir;
  t.after(() => { if (priorTmpdir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = priorTmpdir; });
  const sm = new SessionManager();
  sm.tmuxBin = tmuxBin;
  sm.socket = 'aw-own';
  assert.equal(await sm.clearInstallEnv(), true);

  assert.deepEqual(leaked(dump('aw-own', 'after')), [], 'a new pane sees none of them');
  assert.deepEqual(leaked(dump('aw-other', 'after')), INSTALL_SCOPED_ENV, 'another socket is left alone');
});
