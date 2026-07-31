import test from 'node:test';
import assert from 'node:assert/strict';
import { devShutdownConfig, devShutdownDecision } from './dev-shutdown.js';

const MIN = 60 * 1000;

test('config: AW_DEV unset → disabled, default 30 min when enabled', () => {
  assert.deepEqual(devShutdownConfig({}), { enabled: false, idleMs: 30 * MIN });
  assert.deepEqual(devShutdownConfig({ AW_DEV: '1' }), { enabled: true, idleMs: 30 * MIN });
});

test('config: AW_DEV_IDLE_SHUTDOWN_MIN overrides; 0 disables the idle timer', () => {
  assert.equal(devShutdownConfig({ AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '5' }).idleMs, 5 * MIN);
  assert.equal(devShutdownConfig({ AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: '0' }).idleMs, null);
  // A garbage value falls back to the 30 min default rather than NaN.
  assert.equal(devShutdownConfig({ AW_DEV: '1', AW_DEV_IDLE_SHUTDOWN_MIN: 'x' }).idleMs, 30 * MIN);
});

test('production (disabled) never shuts down — even with a wiped dir', () => {
  assert.equal(devShutdownDecision({
    enabled: false, idleMs: 30 * MIN, now: 1e12, lastClientActivity: 0,
    clientsConnected: 0, dataDirExists: false,
  }), null);
});

test('a wiped data dir wins outright, even with a client connected', () => {
  assert.equal(devShutdownDecision({
    enabled: true, idleMs: 30 * MIN, now: 1e12, lastClientActivity: 1e12,
    clientsConnected: 3, dataDirExists: false,
  }), 'data-dir-removed');
});

test('a connected control client keeps an idle dev instance alive', () => {
  assert.equal(devShutdownDecision({
    enabled: true, idleMs: 30 * MIN, now: 1e12, lastClientActivity: 0,
    clientsConnected: 1, dataDirExists: true,
  }), null);
});

test('idle past the window with no client → exit', () => {
  const now = 1e12;
  assert.equal(devShutdownDecision({
    enabled: true, idleMs: 30 * MIN, now, lastClientActivity: now - 30 * MIN,
    clientsConnected: 0, dataDirExists: true,
  }), 'idle');
});

test('idle but still inside the window → keep running', () => {
  const now = 1e12;
  assert.equal(devShutdownDecision({
    enabled: true, idleMs: 30 * MIN, now, lastClientActivity: now - 29 * MIN,
    clientsConnected: 0, dataDirExists: true,
  }), null);
});

test('idle timer disabled (idleMs null) never idle-exits, but dir-removed still fires', () => {
  assert.equal(devShutdownDecision({
    enabled: true, idleMs: null, now: 1e12, lastClientActivity: 0,
    clientsConnected: 0, dataDirExists: true,
  }), null);
  assert.equal(devShutdownDecision({
    enabled: true, idleMs: null, now: 1e12, lastClientActivity: 0,
    clientsConnected: 0, dataDirExists: false,
  }), 'data-dir-removed');
});
