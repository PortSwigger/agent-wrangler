import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendGuarded, isOverBuffered, MAX_BUFFERED_BYTES } from './ws-backpressure.js';

// A stand-in for a `ws` client: readyState 1 is OPEN, bufferedAmount is the
// send queue the real socket grows when the peer stops reading.
function fakeClient({ bufferedAmount = 0, readyState = 1, sendThrows = false } = {}) {
  return {
    readyState,
    bufferedAmount,
    sent: [],
    terminated: 0,
    closed: 0,
    send(m) { if (sendThrows) throw new Error('socket gone'); this.sent.push(m); },
    terminate() { this.terminated += 1; },
    close() { this.closed += 1; },
  };
}

test('sendGuarded: a healthy client is sent to', () => {
  const c = fakeClient();
  assert.equal(sendGuarded(c, 'hello'), 'sent');
  assert.deepEqual(c.sent, ['hello']);
  assert.equal(c.terminated, 0);
});

test('sendGuarded: a client past the cap is terminated and NOT written to again', () => {
  const c = fakeClient({ bufferedAmount: MAX_BUFFERED_BYTES + 1 });
  assert.equal(sendGuarded(c, 'graph'), 'terminated');
  assert.deepEqual(c.sent, [], 'nothing more was queued onto an already-swamped socket');
  assert.equal(c.terminated, 1);
});

// The regression this whole module exists for: an OPEN socket whose peer never
// reads accreted 411 MB of queued graph snapshots and OOM-killed the server.
// readyState alone (the old guard) does not notice it.
test('sendGuarded: a stalled OPEN client stops accumulating instead of growing without bound', () => {
  const c = fakeClient();
  const msg = 'x'.repeat(1024 * 1024); // ~1 MB, standing in for a graph snapshot
  let terminated = false;
  for (let i = 0; i < 200; i++) {
    const r = sendGuarded(c, msg);
    if (r === 'terminated') { terminated = true; break; }
    c.bufferedAmount += msg.length; // the peer reads nothing, so the queue only grows
  }
  assert.ok(terminated, 'the client was dropped rather than buffered forever');
  assert.ok(c.bufferedAmount <= MAX_BUFFERED_BYTES + msg.length,
    `queue stayed bounded (${c.bufferedAmount} bytes)`);
});

// close() waits on a handshake a non-reading peer will never send, so the queue
// — the memory this is meant to release — would outlive the call.
test('sendGuarded: drops with terminate(), never close()', () => {
  const c = fakeClient({ bufferedAmount: MAX_BUFFERED_BYTES + 1 });
  sendGuarded(c, 'graph');
  assert.equal(c.terminated, 1);
  assert.equal(c.closed, 0);
});

test('sendGuarded: a non-OPEN client is skipped without being terminated', () => {
  for (const readyState of [0, 2, 3]) {
    const c = fakeClient({ readyState, bufferedAmount: MAX_BUFFERED_BYTES + 1 });
    assert.equal(sendGuarded(c, 'graph'), 'closed');
    assert.equal(c.terminated, 0);
    assert.deepEqual(c.sent, []);
  }
});

// One peer torn down mid-broadcast must not abort the loop over the others.
test('sendGuarded: a throwing send reports closed instead of propagating', () => {
  const c = fakeClient({ sendThrows: true });
  assert.equal(sendGuarded(c, 'graph'), 'closed');
});

test('sendGuarded: tolerates a null client', () => {
  assert.equal(sendGuarded(null, 'graph'), 'closed');
});

test('isOverBuffered: boundary is strictly greater than the cap', () => {
  assert.equal(isOverBuffered(fakeClient({ bufferedAmount: MAX_BUFFERED_BYTES })), false);
  assert.equal(isOverBuffered(fakeClient({ bufferedAmount: MAX_BUFFERED_BYTES + 1 })), true);
  assert.equal(isOverBuffered(fakeClient({ bufferedAmount: 0 })), false);
  assert.equal(isOverBuffered({}), false, 'a client not reporting bufferedAmount is not over');
});

test('isOverBuffered: honours an explicit limit', () => {
  assert.equal(isOverBuffered(fakeClient({ bufferedAmount: 50 }), 100), false);
  assert.equal(isOverBuffered(fakeClient({ bufferedAmount: 150 }), 100), true);
});
