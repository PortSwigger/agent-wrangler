import test from 'node:test';
import assert from 'node:assert/strict';
import { gentleKill, stopPaneProcesses } from './tmux-gentle-kill.js';

const tree = new Map([[100, [200]], [200, [300, 301]]]);
const fakeRun = (calls, panes = '100\n') => async (a) => {
  calls.push(a);
  return { stdout: a[0] === 'list-panes' ? panes : '' };
};

test('gentleKill signals the pane descendants, waits for exit, then kills the session', async () => {
  const calls = [];
  const signalled = [];
  const dead = new Set();
  await gentleKill(fakeRun(calls), { session: 'cc_a' }, {
    children: async () => tree,
    signal: (pid) => { signalled.push(pid); dead.add(pid); },
    alive: (pid) => !dead.has(pid),
  });
  assert.deepEqual(signalled, [200, 300, 301]);
  assert.deepEqual(calls.map((c) => c[0]), ['list-panes', 'kill-session']);
  assert.deepEqual(calls[1], ['kill-session', '-t', 'cc_a']);
});

test('gentleKill falls back to kill-session after the grace period if the agent ignores SIGTERM', async () => {
  const calls = [];
  const t0 = Date.now();
  await gentleKill(fakeRun(calls), { session: 'cc_a' }, {
    graceMs: 150, children: async () => tree, signal() {}, alive: () => true,
  });
  assert.ok(Date.now() - t0 >= 150);
  assert.equal(calls.at(-1)[0], 'kill-session');
});

test('gentleKill still kills when the process scan is unavailable or tmux has no panes', async () => {
  for (const [panes, children] of [['100\n', async () => null], ['', async () => tree], ['100\n', async () => { throw new Error('ps hung'); }]]) {
    const calls = [];
    await gentleKill(fakeRun(calls, panes), { session: 'cc_a' }, { children, signal() { throw new Error('no signal expected'); } });
    assert.equal(calls.at(-1)[0], 'kill-session');
  }
});

test('gentleKill propagates the kill failure (session already gone)', async () => {
  const run = async (a) => { if (a[0] === 'kill-session') throw new Error('no such session'); return { stdout: '' }; };
  await assert.rejects(gentleKill(run, { session: 'x' }, { children: async () => tree }), /no such session/);
});

test('server scope lists every pane and ends in kill-server', async () => {
  const calls = [];
  await gentleKill(fakeRun(calls), { all: true }, { children: async () => tree, signal() {}, alive: () => false });
  assert.deepEqual(calls, [['list-panes', '-a', '-F', '#{pane_pid}'], ['kill-server']]);
});

test('stopPaneProcesses never throws when list-panes fails', async () => {
  await stopPaneProcesses(async () => { throw new Error('no server'); }, { session: 'x' });
});
