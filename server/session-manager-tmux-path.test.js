import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionManager } from './session-manager.js';

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
  assert.equal(await sm.refreshTmuxPath({ AW_SUPERVISED: '1', PATH: FRESH }), true);
  assert.deepEqual(sm.calls, [['aw-own', 'set-environment', '-g', 'PATH', FRESH]]);
});

// AW_SUPERVISED is inherited by every pane, so a dev instance started from one
// carries it; AW_DEV and anything other than exactly 1 must leave tmux alone.
for (const [label, env] of [
  ['unsupervised', { PATH: FRESH }],
  ['AW_SUPERVISED=0', { AW_SUPERVISED: '0', PATH: FRESH }],
  ['AW_SUPERVISED=true', { AW_SUPERVISED: 'true', PATH: FRESH }],
  ['inherited AW_SUPERVISED with AW_DEV=1', { AW_SUPERVISED: '1', AW_DEV: '1', PATH: FRESH }],
  ['inherited AW_SUPERVISED with AW_DEV=true', { AW_SUPERVISED: '1', AW_DEV: 'true', PATH: FRESH }],
  ['no PATH to publish', { AW_SUPERVISED: '1' }],
]) {
  test(`PATH refresh is skipped: ${label}`, async () => {
    const sm = recordingManager();
    assert.equal(await sm.refreshTmuxPath(env), false);
    assert.deepEqual(sm.calls, []);
  });
}

test('PATH refresh never targets the default socket before init resolves one', async () => {
  const sm = recordingManager('');
  assert.equal(await sm.refreshTmuxPath({ AW_SUPERVISED: '1', PATH: FRESH }), false);
  assert.deepEqual(sm.calls, []);
});

test('a missing tmux server is harmless', async () => {
  const sm = recordingManager('aw-own', { fail: true });
  assert.equal(await sm.refreshTmuxPath({ AW_SUPERVISED: '1', PATH: FRESH }), false);
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
  assert.equal(await sm.refreshTmuxPath({ AW_SUPERVISED: '1', PATH: FRESH }), true);
  assert.equal(pathOn('aw-own'), `PATH=${FRESH}`);
  assert.equal(pathOn('aw-other'), 'PATH=/stale/bin');
  assert.equal(pathOn('default'), 'PATH=/stale/bin');

  // Dev instance with the supervisor flag inherited: nothing changes.
  assert.equal(await sm.refreshTmuxPath({ AW_SUPERVISED: '1', AW_DEV: '1', PATH: '/dev/checkout/bin' }), false);
  assert.equal(pathOn('aw-own'), `PATH=${FRESH}`);

  // A supervised restart refreshes the already-running owned server again.
  assert.equal(await sm.refreshTmuxPath({ AW_SUPERVISED: '1', PATH: '/newer/bin' }), true);
  assert.equal(pathOn('aw-own'), 'PATH=/newer/bin');

  // No server on the socket: harmless, and it must not start one.
  const missing = new SessionManager();
  missing.tmuxBin = tmuxBin;
  missing.socket = 'aw-missing';
  assert.equal(await missing.refreshTmuxPath({ AW_SUPERVISED: '1', PATH: FRESH }), false);
  const socketDir = path.join(tmpdir, `tmux-${process.getuid()}`);
  assert.equal(fs.existsSync(path.join(socketDir, 'aw-missing')), false);
});
