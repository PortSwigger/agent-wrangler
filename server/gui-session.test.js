import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGuiSession } from './gui-session.js';

const DOCK = { stdout: 'ASN:0x0-0x1234:\n' };
const NO_DOCK = { stdout: '\n' };
const fail = async () => { throw new Error('no server running'); };

function probes({ local, inTmux }) {
  const calls = [];
  return {
    calls,
    exec: async (file, args) => { calls.push(['exec', file, ...args]); return local(); },
    tmux: async (args) => { calls.push(['tmux', ...args]); return inTmux(); },
  };
}

test('wrangler sees the Dock but tmux does not → stale, names the socket', async () => {
  const p = probes({ local: async () => DOCK, inTmux: async () => NO_DOCK });
  assert.deepEqual(await checkGuiSession({ platform: 'darwin', socket: 'aw-1', ...p }), { socket: 'aw-1' });
  assert.deepEqual(p.calls, [
    ['exec', 'lsappinfo', 'find', 'bundleid=com.apple.dock'],
    ['tmux', 'run-shell', 'lsappinfo find bundleid=com.apple.dock'],
  ]);
});

test('both see the Dock → fine', async () => {
  const p = probes({ local: async () => DOCK, inTmux: async () => DOCK });
  assert.equal(await checkGuiSession({ platform: 'darwin', socket: 'aw-1', ...p }), null);
});

test('no tmux server on the socket → nothing to warn about', async () => {
  const p = probes({ local: async () => DOCK, inTmux: fail });
  assert.equal(await checkGuiSession({ platform: 'darwin', socket: 'aw-1', ...p }), null);
});

test('wrangler itself cannot see the Dock → no warning, and tmux is not probed', async () => {
  const p = probes({ local: async () => NO_DOCK, inTmux: async () => NO_DOCK });
  assert.equal(await checkGuiSession({ platform: 'darwin', socket: 'aw-1', ...p }), null);
  assert.equal(p.calls.length, 1);
});

test('lsappinfo unavailable → no warning', async () => {
  const p = probes({ local: fail, inTmux: async () => NO_DOCK });
  assert.equal(await checkGuiSession({ platform: 'darwin', socket: 'aw-1', ...p }), null);
});

test('not macOS → never probes', async () => {
  const p = probes({ local: async () => DOCK, inTmux: async () => NO_DOCK });
  assert.equal(await checkGuiSession({ platform: 'linux', socket: 'aw-1', ...p }), null);
  assert.equal(p.calls.length, 0);
});
