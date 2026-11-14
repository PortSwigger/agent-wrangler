import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeControlMessage, invalidateHandlerMap, _resetRouterForTests } from './router.js';
import { getExtensions, registerExtension, unregisterExtension, _resetExtensionsForTests } from '../extensions/index.js';
import { requestOrigin } from '../request-origin.js';

// A ctx double that records what each action drove: send() captures result
// frames, reply() any event a handler sends before its last reply.
function ctx(overrides = {}) {
  const sent = [];
  const events = [];
  return {
    sent,
    events,
    send: (obj) => sent.push(obj),
    reply: (obj) => events.push(obj),
    rebuild: async () => {},
    ...overrides,
  };
}

let seq = 0;
const action = (name, args = {}) => JSON.stringify({ type: 'action', id: ++seq, action: name, session: null, args });
const result = (c) => {
  const { id: _id, ...rest } = c.sent.at(-1) ?? {};
  return rest;
};

test('routeControlMessage dispatches an action to its handler', async () => {
  let saw = null;
  const c = ctx({ rebuild: async () => { saw = 'rebuilt'; } });
  await routeControlMessage(action('deck.refresh'), c);
  assert.equal(saw, 'rebuilt');
  assert.deepEqual(result(c), { type: 'result', ok: true, data: null });
});

test('routeControlMessage refuses an action the deck does not offer', async () => {
  const c = ctx();
  await routeControlMessage(action('deck.no-such-action'), c);
  assert.equal(result(c).error.code, 'unsupported');
});

test('routeControlMessage drops a malformed frame and any frame that is not an action', async () => {
  const c = ctx();
  await assert.doesNotReject(routeControlMessage('not json{', c));
  await routeControlMessage(JSON.stringify({ type: 'refresh' }), c);
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.events, []);
});

test('routeControlMessage turns a handler throw into a failed result', async () => {
  const c = ctx({ rebuild: async () => { throw new Error('boom'); } });
  await routeControlMessage(action('deck.refresh'), c);
  assert.deepEqual(result(c), { type: 'result', ok: false, data: null, error: { code: 'failed', message: 'boom' } });
});

// Same branch as mcp/server.js: a tagged (extension) handler gets its own facade
// in place of ctx, an untagged (core) one is unchanged — and a throw from either
// is a failed result, so a bad extension action cannot kill the socket.
test('an extension handler is invoked with its facade, not ctx', async () => {
  const seen = [];
  const host = { id: 'fake' };
  const c = ctx({ hostApiFor: (id) => (id === 'fake' ? host : null) });
  await routeControlMessage(action('ext.fake.fake-do', { a: 1 }), c, {
    handlers: [{ type: 'fake-do', extId: 'fake', handler: (msg, arg) => { seen.push({ msg, arg }); } }],
  });
  assert.deepEqual(seen[0].msg, { a: 1, type: 'fake-do' });
  assert.equal(seen[0].arg, host);
  assert.deepEqual(result(c), { type: 'result', ok: true, data: null });
});

test("an extension handler's throw is a failed result", async () => {
  const c = ctx({ hostApiFor: () => ({ id: 'fake' }) });
  await routeControlMessage(action('ext.fake.fake-do'), c, {
    handlers: [{ type: 'fake-do', extId: 'fake', handler: () => { throw new Error('boom'); } }],
  });
  assert.deepEqual(result(c).error, { code: 'failed', message: 'boom' });
});

// The lazy registry is the one cached read of the extension registry, so a live
// register has to invalidate it — without this a handler installed or enabled
// in-process is simply never found, for the life of the server.
test('invalidateHandlerMap is what makes a live-registered handler routable', async () => {
  _resetExtensionsForTests();
  const loaded = getExtensions({ cfg: {}, builtin: [] });
  _resetRouterForTests();
  const c = ctx({ hostApiFor: () => ({ id: 'live' }) });
  await routeControlMessage(action('ext.live.live-do'), c);
  assert.equal(result(c).error.code, 'unsupported', 'not registered yet');

  let saw = null;
  registerExtension(loaded, {
    id: 'live',
    label: 'Live',
    defaultEnabled: true,
    handlers: [{ type: 'live-do', handler: (msg) => { saw = msg; } }],
  }, { cfg: {} });
  // Routing BEFORE the invalidate still misses: the registry was built by the
  // frame above and nothing else ever re-reads it.
  await routeControlMessage(action('ext.live.live-do'), c);
  assert.equal(saw, null);
  invalidateHandlerMap();
  await routeControlMessage(action('ext.live.live-do', { a: 1 }), c);
  assert.deepEqual(saw, { a: 1, type: 'live-do' });

  unregisterExtension(loaded, 'live');
  invalidateHandlerMap();
  saw = null;
  await routeControlMessage(action('ext.live.live-do'), c);
  assert.equal(saw, null, 'a disabled extension stops receiving actions');
  _resetExtensionsForTests();
  _resetRouterForTests();
});

test('extension handlers can reply only to the requesting socket with their own frame type', async () => {
  const requester = ctx({ hostApiFor: () => ({}) });
  const peer = ctx();
  await routeControlMessage(action('ext.sounds.sounds-get'), requester, {
    handlers: [{ type: 'sounds-get', extId: 'sounds', handler(_msg, _host, reply) {
      reply({ type: 'graph', kind: 'sounds', sounds: {} });
    } }],
  });
  assert.deepEqual(result(requester).data, { type: 'ext:sounds', kind: 'sounds', sounds: {} });
  assert.deepEqual(peer.sent, []);
});

test('an extension handler runs with its own tab as the request origin; a core handler and later code have none', async () => {
  const c = ctx();
  let during = 'unset';
  await routeControlMessage(action('ext.fake.fake-do'), c, {
    handlers: [{ type: 'fake-do', extId: 'fake', handler: async () => { await Promise.resolve(); during = requestOrigin(); } }],
  });
  assert.equal(during, c.reply);
  assert.equal(requestOrigin(), null);
});
