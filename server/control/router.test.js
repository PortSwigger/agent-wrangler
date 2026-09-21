import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeControlMessage, invalidateHandlerMap, _resetRouterForTests } from './router.js';
import { getExtensions, registerExtension, unregisterExtension, _resetExtensionsForTests } from '../extensions/index.js';

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

// Same branch as mcp/server.js: a tagged (extension) handler gets its own facade
// in place of ctx, an untagged (core) one is unchanged — and the shared error
// envelope still applies to both, so a bad extension frame cannot kill the socket.
test('an extension handler is invoked with its facade, not ctx', async () => {
  const seen = [];
  const host = { id: 'fake' };
  const c = ctx({ hostApiFor: (id) => (id === 'fake' ? host : null) });
  await routeControlMessage(JSON.stringify({ type: 'fake-do', a: 1 }), c, {
    handlers: [{ type: 'fake-do', extId: 'fake', handler: (msg, arg) => { seen.push({ msg, arg }); } }],
  });
  assert.deepEqual(seen[0].msg, { type: 'fake-do', a: 1 });
  assert.equal(seen[0].arg, host);
  assert.deepEqual(c.sent, []);
});

test("an extension handler's throw still lands in the error envelope", async () => {
  const c = ctx({ hostApiFor: () => ({ id: 'fake' }) });
  await routeControlMessage(JSON.stringify({ type: 'fake-do' }), c, {
    handlers: [{ type: 'fake-do', extId: 'fake', handler: () => { throw new Error('boom'); } }],
  });
  assert.deepEqual(c.sent, [{ type: 'error', message: 'boom' }]);
});

// The lazy map is the one cached read of the extension registry, so a live
// register has to invalidate it — without this a handler installed or enabled
// in-process is simply never found, for the life of the server.
test('invalidateHandlerMap is what makes a live-registered handler routable', async () => {
  _resetExtensionsForTests();
  const loaded = getExtensions({ cfg: {}, builtin: [] });
  _resetRouterForTests();
  const c = ctx({ hostApiFor: () => ({ id: 'live' }) });
  await routeControlMessage(JSON.stringify({ type: 'live-do' }), c);
  assert.deepEqual(c.sent, [], 'not registered yet — an unknown type is a no-op');

  let saw = null;
  registerExtension(loaded, {
    id: 'live',
    label: 'Live',
    defaultEnabled: true,
    handlers: [{ type: 'live-do', handler: (msg) => { saw = msg; } }],
  }, { cfg: {} });
  // Routing BEFORE the invalidate still misses: the map was built by the frame
  // above and nothing else ever re-reads the registry.
  await routeControlMessage(JSON.stringify({ type: 'live-do' }), c);
  assert.equal(saw, null);
  invalidateHandlerMap();
  await routeControlMessage(JSON.stringify({ type: 'live-do', a: 1 }), c);
  assert.deepEqual(saw, { type: 'live-do', a: 1 });

  unregisterExtension(loaded, 'live');
  invalidateHandlerMap();
  saw = null;
  await routeControlMessage(JSON.stringify({ type: 'live-do' }), c);
  assert.equal(saw, null, 'a disabled extension stops receiving frames');
  _resetExtensionsForTests();
  _resetRouterForTests();
});
