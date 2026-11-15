import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installShutdownLog } from './shutdown-log.js';
import { createRestartBarrier } from './restart-barrier.js';

test('supervisor signals drain in-flight writes before cleanup and exit', async () => {
  const lifecycle = new EventEmitter();
  const exits = [];
  const cleanups = [];
  lifecycle.exit = (code) => exits.push(code);
  const shutdown = installShutdownLog({ process: lifecycle, onLine: () => {} });
  shutdown.onShutdown(() => cleanups.push('released'));
  const barrier = createRestartBarrier({ timeoutMs: 1000, settleMs: 0 });
  let restarting;
  shutdown.onSignal((signal, finish) => (restarting = barrier.request(signal, finish)));
  let release;
  const write = barrier.run(() => new Promise((r) => { release = r; }));
  lifecycle.emit('SIGTERM');
  assert.deepEqual(cleanups, []);
  assert.deepEqual(exits, []);
  release();
  await write;
  assert.equal(await restarting, true);
  assert.deepEqual(cleanups, ['released']);
  assert.deepEqual(exits, [0]);
});

test('a timed out signal stops without reopening admission', { timeout: 1000 }, async (t) => {
  const lifecycle = new EventEmitter();
  const cleanups = [];
  let exited;
  const stopped = new Promise((r) => { exited = r; });
  lifecycle.exit = () => { cleanups.push('exit'); exited(); };
  const shutdown = installShutdownLog({ process: lifecycle, onLine: () => {}, signalTimeoutMs: 10 });
  shutdown.onShutdown(() => cleanups.push('released'));
  const barrier = createRestartBarrier({ timeoutMs: 1000, settleMs: 0 });
  let restarting;
  shutdown.onSignal((signal, finish) => (restarting = barrier.request(signal, finish)));
  let release;
  const write = barrier.run(() => new Promise((r) => { release = r; }));
  lifecycle.emit('SIGTERM');
  t.after(() => release());
  await stopped;
  assert.equal(barrier.draining(), true);
  assert.deepEqual(cleanups, ['released', 'exit']);
  release();
  await write;
  await restarting;
  assert.deepEqual(cleanups, ['released', 'exit']);
});

test('a second signal stops immediately even with an in-flight write', async () => {
  const lifecycle = new EventEmitter();
  const cleanups = [];
  lifecycle.exit = () => cleanups.push('exit');
  const shutdown = installShutdownLog({ process: lifecycle, onLine: () => {} });
  shutdown.onShutdown(() => cleanups.push('released'));
  const barrier = createRestartBarrier({ timeoutMs: 1000, settleMs: 0 });
  let restarting;
  shutdown.onSignal((signal, finish) => (restarting = barrier.request(signal, finish)));
  let release;
  const write = barrier.run(() => new Promise((r) => { release = r; }));
  lifecycle.emit('SIGTERM');
  assert.deepEqual(cleanups, []);
  lifecycle.emit('SIGINT');
  release();
  assert.deepEqual(cleanups, ['released', 'exit']);
  await write;
  await restarting;
  assert.deepEqual(cleanups, ['released', 'exit']);
});

for (const drain of ['success', 'timeout']) {
  test(`a signal upgrades an existing board drain on ${drain}`, async () => {
    const lifecycle = new EventEmitter();
    const cleanups = [];
    lifecycle.exit = () => cleanups.push('exit');
    const shutdown = installShutdownLog({ process: lifecycle, onLine: () => {} });
    shutdown.onShutdown(() => cleanups.push('released'));
    const automatic = [];
    const barrier = createRestartBarrier({ timeoutMs: 10, settleMs: 0, exit: () => automatic.push('exit') });
    shutdown.onSignal((signal, finish) => barrier.request(signal, finish));
    let release;
    const write = barrier.run(() => new Promise((r) => { release = r; }));
    const restart = barrier.request('board');
    lifecycle.emit('SIGTERM');
    if (drain === 'success') release();
    const outcome = await restart;
    release();
    await write;
    assert.equal(outcome, true);
    assert.deepEqual(automatic, []);
    assert.deepEqual(cleanups, ['released', 'exit']);
    assert.notEqual(barrier.status().phase, 'pending');
  });
}
