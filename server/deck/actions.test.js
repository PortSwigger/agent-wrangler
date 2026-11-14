import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeControlMessage } from '../control/router.js';
import { buildActionRegistry, handleAction, DeckError, deckEvent } from './actions.js';

function ctx(overrides = {}) {
  const sent = [];
  const replies = [];
  return {
    sent,
    replies,
    send: (obj) => sent.push(obj),
    reply: (obj) => replies.push(obj),
    rebuild: async () => {},
    sessionFromGraph: (id) => (id === 'known' ? { sessionId: 'known' } : null),
    sessionManager: { entryFor: () => null },
    graph: () => ({ history: [{ sessionId: 'archived-one' }] }),
    ...overrides,
  };
}

const action = (body) => JSON.stringify({ type: 'action', ...body });

test('an action not in the registry is refused with unsupported', async () => {
  const c = ctx();
  await routeControlMessage(action({ id: 1, action: 'session.teleport', args: {} }), c);
  assert.deepEqual(c.sent, [{ type: 'result', id: 1, ok: false, data: null, error: { code: 'unsupported', message: 'This deck does not offer session.teleport' } }]);
});

test('a legacy control type is not reachable as an action name', async () => {
  const c = ctx();
  await routeControlMessage(action({ id: 'a', action: 'refresh' }), c);
  assert.equal(c.sent[0].error.code, 'unsupported');
});

test('a malformed envelope is refused with invalid, and still gets a result', async () => {
  for (const [body, message] of [
    [{ action: 'deck.refresh' }, 'An action needs an id'],
    [{ id: 2 }, 'An action needs a name'],
    [{ id: 3, action: 'deck.refresh', args: [1] }, 'args must be an object'],
    [{ id: 4, action: 'deck.refresh', session: 7 }, 'session must be a session id'],
  ]) {
    const c = ctx();
    await routeControlMessage(action(body), c);
    assert.equal(c.sent.length, 1);
    assert.equal(c.sent[0].type, 'result');
    assert.equal(c.sent[0].ok, false);
    assert.deepEqual(c.sent[0].error, { code: 'invalid', message });
  }
});

test('a core action runs its handler and answers ok with no data when it does not reply', async () => {
  let rebuilt = false;
  const c = ctx({ rebuild: async () => { rebuilt = true; } });
  await routeControlMessage(action({ id: 5, action: 'deck.refresh' }), c);
  assert.equal(rebuilt, true);
  assert.deepEqual(c.sent, [{ type: 'result', id: 5, ok: true, data: null }]);
});

test("the handler's reply becomes the result data; args and session fill the legacy message", async () => {
  const seen = [];
  const handlers = [{ type: 'archive', handler: (msg, cx) => { seen.push(msg); cx.reply({ type: 'archived', sessionId: msg.sessionId }); } }];
  const c = ctx();
  await routeControlMessage(action({ id: 6, action: 'session.archive', session: 'known', args: { keepWorktree: true } }), c, { handlers });
  assert.deepEqual(seen, [{ type: 'archive', keepWorktree: true, sessionId: 'known' }]);
  assert.deepEqual(c.sent, [{ type: 'result', id: 6, ok: true, data: { type: 'archived', sessionId: 'known' } }]);
  assert.deepEqual(c.replies, []);
});

test('an error reply or a throw becomes a failed result', async () => {
  const replying = [{ type: 'dispatch', handler: (msg, cx) => cx.reply({ type: 'error', message: 'Dispatch failed' }) }];
  const c1 = ctx();
  await routeControlMessage(action({ id: 7, action: 'session.dispatch', args: {} }), c1, { handlers: replying });
  assert.deepEqual(c1.sent, [{ type: 'result', id: 7, ok: false, data: null, error: { code: 'failed', message: 'Dispatch failed' } }]);

  const throwing = [{ type: 'dispatch', handler: () => { throw new Error('boom'); } }];
  const c2 = ctx();
  await routeControlMessage(action({ id: 8, action: 'session.dispatch' }), c2, { handlers: throwing });
  assert.deepEqual(c2.sent, [{ type: 'result', id: 8, ok: false, data: null, error: { code: 'failed', message: 'boom' } }]);
});

test('earlier and late replies go out as events tagged with the action id', async () => {
  let later;
  const handlers = [{
    type: 'search-reindex',
    handler: (msg, cx) => {
      cx.reply({ type: 'search-status', building: true });
      cx.reply({ type: 'search-status', building: false });
      later = () => cx.reply({ type: 'search-status', rebuilt: true });
    },
  }];
  const c = ctx();
  await routeControlMessage(action({ id: 9, action: 'deck.search-reindex' }), c, { handlers });
  later();
  assert.deepEqual(c.sent, [
    { type: 'event', event: 'search-status', session: null, data: { type: 'search-status', building: true }, id: 9 },
    { type: 'result', id: 9, ok: true, data: { type: 'search-status', building: false } },
    { type: 'event', event: 'search-status', session: null, data: { type: 'search-status', rebuilt: true }, id: 9 },
  ]);
});

test('a session action naming an unknown session is refused with not-found', async () => {
  let ran = false;
  const handlers = [{ type: 'rename', handler: () => { ran = true; } }];
  const c = ctx();
  await routeControlMessage(action({ id: 10, action: 'session.rename', session: 'nobody', args: { name: 'x' } }), c, { handlers });
  assert.equal(ran, false);
  assert.equal(c.sent[0].error.code, 'not-found');

  const c2 = ctx();
  await routeControlMessage(action({ id: 11, action: 'session.rename', session: 'archived-one', args: { name: 'x' } }), c2, { handlers });
  assert.equal(ran, true, 'a session only in history is still known');
  assert.equal(c2.sent[0].ok, true);
});

test('an extension action is ext.<id>.<type>, runs with its facade, and its reply is the data', async () => {
  const host = { id: 'fake' };
  const handlers = [{ type: 'fake-do', extId: 'fake', handler: (msg, h, reply) => { assert.equal(h, host); reply({ n: msg.n }); } }];
  const c = ctx({ hostApiFor: (id) => (id === 'fake' ? host : null) });
  await routeControlMessage(action({ id: 12, action: 'ext.fake.fake-do', args: { n: 3 } }), c, { handlers });
  assert.deepEqual(c.sent, [{ type: 'result', id: 12, ok: true, data: { n: 3, type: 'ext:fake' } }]);
});

test('a native action returns its data, and a DeckError keeps its code', async () => {
  const registry = buildActionRegistry({
    handlers: [],
    native: [
      { action: 'deck.echo', run: async (args) => ({ echoed: args.v }) },
      { action: 'deck.clash', run: async () => { throw new DeckError('conflict', 'moved'); } },
    ],
  });
  const c = ctx();
  await handleAction({ id: 1, action: 'deck.echo', args: { v: 2 } }, c, { registry });
  await handleAction({ id: 2, action: 'deck.clash' }, c, { registry });
  assert.deepEqual(c.sent, [
    { type: 'result', id: 1, ok: true, data: { echoed: 2 } },
    { type: 'result', id: 2, ok: false, data: null, error: { code: 'conflict', message: 'moved' } },
  ]);
});

test('session.file maps a refused path onto an error code and reads a good one', async () => {
  const reads = { '/a.md': { status: 200, path: '/a.md', content: '# hi' }, '/b.txt': { status: 415, message: 'not a markdown file' }, '/c.md': { status: 404, message: 'not found' } };
  const c = ctx({ readMarkdownFile: async (p) => reads[p] });
  for (const [id, path] of [[1, '/a.md'], [2, '/b.txt'], [3, '/c.md']]) {
    await routeControlMessage(action({ id, action: 'session.file', args: { path } }), c);
  }
  assert.deepEqual(c.sent, [
    { type: 'result', id: 1, ok: true, data: { path: '/a.md', content: '# hi' } },
    { type: 'result', id: 2, ok: false, data: null, error: { code: 'invalid', message: 'not a markdown file' } },
    { type: 'result', id: 3, ok: false, data: null, error: { code: 'not-found', message: 'not found' } },
  ]);
});

test('deck.ext-file answers the file, and refuses an unregistered path as forbidden', async () => {
  const c = ctx({ openExtFile: async (ext, p) => (ext === 'todos' && p === '/ok.md' ? { ok: true, path: p, kind: 'markdown', content: 'x' } : { ok: false, reason: 'not-permitted' }) });
  await routeControlMessage(action({ id: 1, action: 'deck.ext-file', args: { ext: 'todos', path: '/ok.md' } }), c);
  await routeControlMessage(action({ id: 2, action: 'deck.ext-file', args: { ext: 'todos', path: '/nope.md' } }), c);
  await routeControlMessage(action({ id: 3, action: 'deck.ext-file', args: { path: '/ok.md' } }), c);
  assert.deepEqual(c.sent.map((m) => (m.ok ? m.data.path : m.error.code)), ['/ok.md', 'forbidden', 'invalid']);
});

test('deckEvent takes the session from the payload, then from the action', () => {
  assert.deepEqual(deckEvent({ type: 'notify', session: { sessionId: 's1' } }), { type: 'event', event: 'notify', session: 's1', data: { type: 'notify', session: { sessionId: 's1' } } });
  assert.equal(deckEvent({ type: 'chat' }, { session: 's2' }).session, 's2');
  assert.equal(deckEvent({ type: 'x', sessionId: 's3' }, { session: 's2' }).session, 's3');
});
