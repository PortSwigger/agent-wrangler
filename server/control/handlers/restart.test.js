import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { restartHandler, restartSupported } from './restart.js';

// ctx.canRestart is restartSupported() at connect: AW_SUPERVISED as captured at
// startup (install-env.js), which only a supervisor's start path sets. Under
// `npm start` an exit is a shutdown with nothing to restart the board.
function ctx(canRestart) {
  const calls = { replies: [], restarts: 0 };
  return { calls, canRestart, reply: (o) => calls.replies.push(o), restart: () => { calls.restarts += 1; } };
}

test('an unsupervised restart is refused rather than exiting the board', async () => {
  const c = ctx(false);
  await assert.rejects(() => restartHandler.handler({}, c), /not started by a supervisor/);
  assert.equal(c.calls.restarts, 0, 'nothing exits');
});

// The ack has to be written BEFORE the exit is armed: the socket dies with the
// process, and it is the only thing that turns the button into "Restarting…".
test('a supervised restart acks first, then exits', async () => {
  const c = ctx(true);
  await restartHandler.handler({}, c);
  assert.deepEqual(c.calls.replies, [{ type: 'restart-ack' }]);
  assert.equal(c.calls.restarts, 1);
});

test('restart support needs a supervisor and no dev instance', () => {
  assert.equal(restartSupported({ supervised: true, dev: false }), true);
  assert.equal(restartSupported({ supervised: false, dev: false }), false);
  assert.equal(restartSupported({ supervised: false, dev: true }), false);
  // A dev instance started from a pane that predates the env cleanup still
  // carries AW_SUPERVISED=1, but nothing restarts it.
  assert.equal(restartSupported({ supervised: true, dev: true }), false);
});

test('the handler follows the capability, not just the flag', async () => {
  const dev = ctx(restartSupported({ supervised: true, dev: true }));
  await assert.rejects(() => restartHandler.handler({}, dev), /not started by a supervisor/);
  assert.equal(dev.calls.restarts, 0);
  const service = ctx(restartSupported({ supervised: true, dev: false }));
  await restartHandler.handler({}, service);
  assert.equal(service.calls.restarts, 1);
});

// The defaults read AW_SUPERVISED as install-env.js captured it at import and
// AW_DEV from the live env, the same way server/index.js calls it.
test('a real start with captured AW_SUPERVISED=1 is restartable unless AW_DEV is set', () => {
  const probe = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    await import(${JSON.stringify(new URL('../../install-env.js', import.meta.url).href)});
    const { restartSupported } = await import(${JSON.stringify(new URL('./restart.js', import.meta.url).href)});
    console.log(JSON.stringify(restartSupported()));
  `], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }));
  assert.equal(probe({ AW_SUPERVISED: '1' }), true);
  assert.equal(probe({ AW_SUPERVISED: '1', AW_DEV: '1' }), false);
  assert.equal(probe({}), false);
});
