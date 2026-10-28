import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtTerminalOpener } from './ext-terminals.js';
import { TerminalRegistry } from './terminal-registry.js';

function setup() {
  const alive = new Set();
  const created = [];
  const broadcasts = [];
  const registry = new TerminalRegistry();
  let n = 0;
  const { create: open, alive: isLive } = createExtTerminalOpener({
    createShellSession: async (cwd, socket, command) => {
      const name = `sh_${n++}`;
      created.push({ cwd, socket, command, name });
      alive.add(name);
      return name;
    },
    socket: () => 'aw-sock',
    terminalRegistry: registry,
    broadcast: (f) => broadcasts.push(f),
    isAlive: async ({ tmuxName }) => alive.has(tmuxName),
  });
  return { open, isLive, alive, created, broadcasts, registry };
}

test('the default presentation broadcasts the sidebar frame to every tab, as before', async () => {
  const { open, broadcasts, registry } = setup();
  const { terminalId } = await open({ cwd: '/a', command: 'echo hi' }, { origin: () => assert.fail('no per-tab send') });
  assert.deepEqual(broadcasts, [{ type: 'open-terminal', terminalId, command: 'echo hi', sessionId: null }]);
  assert.equal(registry.get(terminalId).detachable, undefined);
});

test('a dialog goes only to the requesting tab and is registered detachable', async () => {
  const { open, broadcasts, registry } = setup();
  const sent = [];
  const { terminalId } = await open({ cwd: '/a', command: 'claude', presentation: 'dialog', title: 'Log in' }, { origin: (f) => sent.push(f) });
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(sent, [{ type: 'open-terminal', terminalId, command: 'claude', sessionId: null, presentation: 'dialog', title: 'Log in' }]);
  assert.equal(registry.get(terminalId).detachable, true);
});

test('a dialog with no requesting tab starts the shell and presents nothing', async () => {
  const { open, broadcasts, created } = setup();
  const r = await open({ cwd: '/a', presentation: 'dialog' });
  assert.equal(created.length, 1);
  assert.deepEqual(broadcasts, []);
  assert.equal(r.reused, false);
});

test('a live key presents the same shell again without typing the command twice', async () => {
  const { open, created } = setup();
  const first = await open({ cwd: '/a', command: 'claude', presentation: 'dialog', key: 'x:login' }, { origin: () => {} });
  const sent = [];
  const again = await open({ cwd: '/a', command: 'claude', presentation: 'dialog', title: 'Reopen', key: 'x:login' }, { origin: (f) => sent.push(f) });
  assert.equal(created.length, 1);
  assert.deepEqual(again, { terminalId: first.terminalId, reused: true });
  assert.deepEqual(sent, [{ type: 'open-terminal', terminalId: first.terminalId, command: 'claude', sessionId: null, presentation: 'dialog', title: 'Reopen' }]);
});

test('a key whose shell has exited starts a fresh one and drops the dead entry', async () => {
  const { open, alive, created, registry } = setup();
  const first = await open({ cwd: '/a', presentation: 'dialog', key: 'x:login' }, { origin: () => {} });
  alive.clear();
  const next = await open({ cwd: '/a', presentation: 'dialog', key: 'x:login' }, { origin: () => {} });
  assert.equal(created.length, 2);
  assert.notEqual(next.terminalId, first.terminalId);
  assert.equal(registry.get(first.terminalId), null);
});

test('two creates racing on one key share one shell', async () => {
  const { open, created } = setup();
  const [a, b] = await Promise.all([
    open({ cwd: '/a', presentation: 'dialog', key: 'x:login' }, { origin: () => {} }),
    open({ cwd: '/a', presentation: 'dialog', key: 'x:login' }, { origin: () => {} }),
  ]);
  assert.equal(created.length, 1);
  assert.equal(a.terminalId, b.terminalId);
  assert.equal(b.reused, true);
});

test('keys without a live match never reuse another key\'s shell', async () => {
  const { open, created } = setup();
  await open({ cwd: '/a', presentation: 'dialog', key: 'x:one' });
  await open({ cwd: '/a', presentation: 'dialog', key: 'y:one' });
  assert.equal(created.length, 2);
});

test('alive answers for the owner\'s live terminal only, and forgets one whose shell has exited', async () => {
  const { open, isLive, alive, registry } = setup();
  const { terminalId } = await open({ cwd: '/a', presentation: 'dialog', key: 'x:login' }, { owner: 'x' });
  assert.equal(await isLive(terminalId, 'x'), true);
  assert.equal(await isLive(terminalId, 'y'), false);
  assert.equal(await isLive('t_unknown', 'x'), false);
  alive.clear();
  assert.equal(await isLive(terminalId, 'x'), false);
  assert.equal(registry.get(terminalId), null);
});
