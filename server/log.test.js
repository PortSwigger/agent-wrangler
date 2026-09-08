import test from 'node:test';
import assert from 'node:assert/strict';

import { stamp, log, logWarn, logError, humanDuration } from './log.js';
import { shutdownLine, installShutdownLog } from './shutdown-log.js';

function capture(channel, fn) {
  const calls = [];
  const orig = console[channel];
  console[channel] = (...args) => calls.push(args);
  try { fn(); } finally { console[channel] = orig; }
  return calls;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

test('stamp is an ISO 8601 UTC instant', () => {
  assert.equal(stamp(new Date(Date.UTC(2026, 8, 8, 8, 14, 19, 123))), '2026-09-08T08:14:19.123Z');
});

test('every channel prefixes a timestamp', () => {
  assert.match(capture('log', () => log('[tag] hello'))[0][0], ISO);
  assert.match(capture('warn', () => logWarn('[tag] hello'))[0][0], ISO);
  assert.match(capture('error', () => logError('[tag] hello'))[0][0], ISO);
});

// The stamp joins the first argument rather than becoming one of its own: a test
// (or any consumer) capturing only the first argument must still see the message.
test('the stamp is prefixed into a leading string argument, not passed separately', () => {
  const [args] = capture('error', () => logError('mappings.json is corrupt'));
  assert.equal(args.length, 1);
  assert.match(args[0], /^.+Z mappings\.json is corrupt$/);
});

// console.error('[uncaughtException]', err) must keep the Error as its own argument
// or console renders "[object Object]" instead of a stack.
test('trailing arguments are left alone so an Error still renders as a stack', () => {
  const err = new Error('boom');
  const [args] = capture('error', () => logError('[uncaughtException]', err));
  assert.equal(args.length, 2);
  assert.match(args[0], ISO);
  assert.equal(args[1], err);
});

test('a non-string first argument gets the stamp as its own argument', () => {
  const err = new Error('boom');
  const [args] = capture('error', () => logError(err));
  assert.match(args[0], /Z$/);
  assert.equal(args[1], err);
});

test('humanDuration keeps to two units and rounds down', () => {
  assert.equal(humanDuration(0), '0m');
  assert.equal(humanDuration(59 * 1000), '0m');
  assert.equal(humanDuration(3 * 60 * 1000), '3m');
  assert.equal(humanDuration((8 * 3600 + 3 * 60 + 59) * 1000), '8h3m');
  assert.equal(humanDuration(12.5 * 86400 * 1000), '12d12h');
  assert.equal(humanDuration(undefined), 'unknown');
  assert.equal(humanDuration(-1), 'unknown');
});

test('shutdownLine names the recorded reason when there is one, else the exit code', () => {
  assert.equal(
    shutdownLine({ reason: 'signal SIGTERM', code: 0, uptimeMs: 3 * 3600 * 1000, pid: 58457 }),
    '[agent-wrangler] shutting down (signal SIGTERM) — pid 58457, up 3h0m',
  );
  assert.equal(
    shutdownLine({ code: 1, uptimeMs: 2000, pid: 12 }),
    '[agent-wrangler] shutting down (exit code 1) — pid 12, up 0m',
  );
});

// Installs its own handlers rather than sitting beside someone else's: a listener
// that only recorded the signal would suppress Node's default termination and hang
// the stop, and one registered later would miss a stop during startup.
function withShutdownLog(fn) {
  const exitBefore = process.listenerCount('exit');
  const sigBefore = process.listenerCount('SIGTERM');
  const lines = [];
  const api = installShutdownLog({ pid: 7, startedAt: Date.now(), onLine: (l) => lines.push(l) });
  const exitHook = process.listeners('exit').at(-1);
  const sigHook = process.listeners('SIGTERM').at(-1);
  try {
    fn({ api, lines, exitHook, sigHook });
  } finally {
    process.off('exit', exitHook);
    process.off('SIGTERM', sigHook);
    process.off('SIGINT', process.listeners('SIGINT').at(-1));
    assert.equal(process.listenerCount('exit'), exitBefore);
    assert.equal(process.listenerCount('SIGTERM'), sigBefore);
  }
}

test('installShutdownLog owns the signal handlers, so a stop is never left to default termination', () => {
  withShutdownLog(({ sigHook }) => {
    assert.equal(typeof sigHook, 'function');
    assert.ok(process.listenerCount('SIGINT') > 0);
  });
});

test('a recorded reason is reported exactly once, from the exit hook', () => {
  withShutdownLog(({ api, lines, exitHook }) => {
    api.noteReason('signal SIGINT');
    assert.deepEqual(lines, []); // nothing yet — the reason is only recorded
    exitHook(0);
    assert.deepEqual(lines.length, 1);
    assert.match(lines[0], /shutting down \(signal SIGINT\) — pid 7/);
  });
});

test('a self-inflicted exit carries its own reason instead of a bare exit code', () => {
  withShutdownLog(({ api, lines, exitHook }) => {
    api.noteReason('dev instance reaped: idle');
    exitHook(0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /shutting down \(dev instance reaped: idle\)/);
  });
});

test('installShutdownLog falls back to the exit code when nothing recorded a reason', () => {
  withShutdownLog(({ lines, exitHook }) => {
    exitHook(1);
    assert.match(lines[0], /shutting down \(exit code 1\)/);
  });
});

// Releasing the instance lock rides these cleanups rather than a second handler.
test('onShutdown cleanups run before the exit, and one throwing cannot block it', () => {
  withShutdownLog(({ api, lines }) => {
    const ran = [];
    api.onShutdown(() => { ran.push('a'); throw new Error('boom'); });
    api.onShutdown(() => ran.push('b'));
    const origExit = process.exit;
    process.exit = () => {};
    try {
      process.listeners('SIGTERM').at(-1)();
    } finally {
      process.exit = origExit;
    }
    assert.deepEqual(ran, ['a', 'b']);
    assert.deepEqual(lines, []); // the line comes from the exit hook, not the signal
  });
});
