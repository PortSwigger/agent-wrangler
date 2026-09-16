import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartHandler, restartSupported } from './restart.js';

function ctx() {
  const calls = { replies: [], restarts: 0 };
  return { calls, reply: (o) => calls.replies.push(o), restart: () => { calls.restarts += 1; } };
}

function withSupervised(value, fn) {
  const prior = process.env.AW_SUPERVISED;
  if (value == null) delete process.env.AW_SUPERVISED;
  else process.env.AW_SUPERVISED = value;
  try { return fn(); } finally {
    if (prior == null) delete process.env.AW_SUPERVISED;
    else process.env.AW_SUPERVISED = prior;
  }
}

// The flag says "something will bring me back", and only scripts/wrangler-start.sh
// (what BOTH the launchd plist and the systemd unit exec) sets it. Under
// `npm start` an exit is a shutdown with nothing to restart the board.
test('a restart is offered only under a supervisor', () => {
  withSupervised('1', () => assert.equal(restartSupported(), true));
  withSupervised(null, () => assert.equal(restartSupported(), false));
  withSupervised('0', () => assert.equal(restartSupported(), false));
});

test('an unsupervised restart is refused rather than exiting the board', async () => {
  await withSupervised(null, async () => {
    const c = ctx();
    await assert.rejects(() => restartHandler.handler({}, c), /not started by a supervisor/);
    assert.equal(c.calls.restarts, 0, 'nothing exits');
  });
});

// The ack has to be written BEFORE the exit is armed: the socket dies with the
// process, and it is the only thing that turns the button into "Restarting…".
test('a supervised restart acks first, then exits', async () => {
  await withSupervised('1', async () => {
    const c = ctx();
    await restartHandler.handler({}, c);
    assert.deepEqual(c.calls.replies, [{ type: 'restart-ack' }]);
    assert.equal(c.calls.restarts, 1);
  });
});
