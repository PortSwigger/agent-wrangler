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
  shutdown.onSignal((signal, finish) => { restarting = barrier.request(signal, finish); });
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

test('a timed out signal leaves ownership intact and a later signal can retry', async () => {
  const lifecycle = new EventEmitter();
  const cleanups = [];
  lifecycle.exit = () => cleanups.push('exit');
  const shutdown = installShutdownLog({ process: lifecycle, onLine: () => {} });
  shutdown.onShutdown(() => cleanups.push('released'));
  const barrier = createRestartBarrier({ timeoutMs: 10, settleMs: 0 });
  let restarting;
  shutdown.onSignal((signal, finish) => { restarting = barrier.request(signal, finish); });
  let release;
  const write = barrier.run(() => new Promise((r) => { release = r; }));
  lifecycle.emit('SIGTERM');
  assert.equal(await restarting, false);
  assert.deepEqual(cleanups, []);
  release();
  await write;
  lifecycle.emit('SIGTERM');
  assert.equal(await restarting, true);
  assert.deepEqual(cleanups, ['released', 'exit']);
});
