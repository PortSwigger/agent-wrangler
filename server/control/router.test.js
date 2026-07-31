import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeControlMessage } from './router.js';

// A ctx double that records what each handler drove. reply() captures outbound
// frames so we can assert the error envelope / acks.
function ctx(overrides = {}) {
  const sent = [];
  return {
    sent,
    reply: (obj) => sent.push(obj),
    rebuild: async () => {},
    ...overrides,
  };
}

test('routeControlMessage dispatches a known type to its handler', async () => {
  let saw = null;
  const c = ctx({ rebuild: async () => { saw = 'rebuilt'; } });
  await routeControlMessage(JSON.stringify({ type: 'refresh' }), c);
  assert.equal(saw, 'rebuilt');
});

test('routeControlMessage is a no-op for an unknown type', async () => {
  const c = ctx();
  await routeControlMessage(JSON.stringify({ type: 'no-such-message' }), c);
  assert.deepEqual(c.sent, []);
});

test('routeControlMessage silently drops a malformed frame', async () => {
  const c = ctx();
  await assert.doesNotReject(routeControlMessage('not json{', c));
  assert.deepEqual(c.sent, []);
});

test('routeControlMessage wraps a handler throw in the error envelope', async () => {
  const c = ctx({ rebuild: async () => { throw new Error('boom'); } });
  await routeControlMessage(JSON.stringify({ type: 'refresh' }), c);
  assert.deepEqual(c.sent, [{ type: 'error', message: 'boom' }]);
});
