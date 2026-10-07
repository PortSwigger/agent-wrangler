import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartHandler } from './restart.js';

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
