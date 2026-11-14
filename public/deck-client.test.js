import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiMajor, createDeckClient, stateToGraph, supportedItems } from './deck-client.js';

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.all.push(this);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const flush = () => new Promise((r) => setImmediate(r));

function harness(descriptor) {
  FakeSocket.all = [];
  const fetched = [];
  const statuses = [];
  const states = [];
  const events = [];
  const timers = [];
  const client = createDeckClient({
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, json: async () => descriptor }; },
    WebSocketImpl: FakeSocket,
    location: { protocol: 'http:', host: 'localhost:7777' },
    onStatus: (s) => statuses.push(s),
    onState: (f) => states.push(f),
    onEvent: (f) => events.push(f),
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return { client, fetched, statuses, states, events, timers };
}

const DECK = { deckId: 'd1', name: 'laptop', api: '1.0', runtimes: [], actions: ['session.fork', 'session.archive', 'session.file'], extensions: [] };

test('apiMajor reads the major of a version string and nothing else', () => {
  assert.equal(apiMajor('1.0'), 1);
  assert.equal(apiMajor('2.3'), 2);
  assert.equal(apiMajor('1'), 1);
  assert.equal(apiMajor(undefined), null);
  assert.equal(apiMajor('v1'), null);
});

test('the handshake reads GET /deck, then opens /ws with the API major', async () => {
  const h = harness(DECK);
  await h.client.start();
  assert.deepEqual(h.fetched, ['/deck']);
  assert.equal(FakeSocket.all.length, 1);
  assert.equal(FakeSocket.all[0].url, 'ws://localhost:7777/ws?api=1');
  FakeSocket.all[0].open();
  assert.equal(h.client.status(), 'ready');
  assert.deepEqual(h.client.descriptor(), DECK);
});

test('an action gets the result with its id; state and event frames reach their callbacks', async () => {
  const h = harness(DECK);
  await h.client.start();
  const sock = FakeSocket.all[0];
  sock.open();
  const pending = h.client.act('session.fork', { session: 's1', args: { prompt: 'go' } });
  await flush();
  assert.deepEqual(sock.sent, [{ type: 'action', id: 1, action: 'session.fork', session: 's1', args: { prompt: 'go' } }]);
  sock.receive({ type: 'state', rev: 5, sessions: [] });
  sock.receive({ type: 'event', event: 'notify', session: 's1', data: { type: 'notify' } });
  sock.receive({ type: 'result', id: 1, ok: true, data: { type: 'forked', sessionId: 's2' } });
  assert.deepEqual(await pending, { type: 'result', id: 1, ok: true, data: { type: 'forked', sessionId: 's2' } });
  assert.deepEqual(h.states.map((s) => s.rev), [5]);
  assert.deepEqual(h.events.map((e) => e.event), ['notify']);
});

test('an action the deck does not advertise is hidden and refused without being sent', async () => {
  const h = harness(DECK);
  await h.client.start();
  const sock = FakeSocket.all[0];
  sock.open();
  assert.equal(h.client.supports('session.fork'), true);
  assert.equal(h.client.supports('session.rename'), false, 'hidden: not in actions');
  assert.equal(h.client.canSend('session.rename'), false);
  const r = await h.client.act('session.rename', { session: 's1', args: { name: 'x' } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unsupported');
  assert.deepEqual(sock.sent, [], 'refused here: nothing reached the deck');
});

test("an action the card's unsupported list names is hidden for that card only", async () => {
  const h = harness(DECK);
  await h.client.start();
  FakeSocket.all[0].open();
  assert.equal(h.client.supports('session.fork', { sessionId: 'a', unsupported: ['session.fork'] }), false);
  assert.equal(h.client.supports('session.archive', { sessionId: 'a', unsupported: ['session.fork'] }), true);
  assert.equal(h.client.supports('session.fork', { sessionId: 'b' }), true);
});

test("the deck's own unsupported refusal comes back as the result", async () => {
  const h = harness(DECK);
  await h.client.start();
  const sock = FakeSocket.all[0];
  sock.open();
  const pending = h.client.act('session.archive', { session: 's1' });
  await flush();
  sock.receive({ type: 'result', id: 1, ok: false, data: null, error: { code: 'unsupported', message: 'This deck does not offer session.archive' } });
  assert.equal((await pending).error.code, 'unsupported');
});

test('a deck with another major version is incompatible: no socket, nothing supported, no action sent', async () => {
  const h = harness({ ...DECK, api: '2.0' });
  await h.client.start();
  assert.equal(h.client.status(), 'incompatible');
  assert.deepEqual(h.statuses, ['incompatible']);
  assert.equal(FakeSocket.all.length, 0, 'never opened /ws');
  assert.equal(h.client.supports('session.fork'), false);
  assert.equal(h.client.canSend('session.fork'), false);
  const r = await h.client.act('session.fork', { session: 's1' });
  assert.equal(r.error.code, 'unsupported');
  assert.equal(FakeSocket.all.length, 0);
  assert.equal(h.timers.length, 1, 'the handshake is retried later, in case the deck is updated');
});

test('a descriptor with no api at all is incompatible too', async () => {
  const h = harness({ deckId: 'x', actions: ['session.fork'] });
  await h.client.start();
  assert.equal(h.client.status(), 'incompatible');
  assert.equal(FakeSocket.all.length, 0);
});

test('a closed socket settles every pending action as failed and reconnects through the handshake', async () => {
  const h = harness(DECK);
  await h.client.start();
  const sock = FakeSocket.all[0];
  sock.open();
  const pending = h.client.act('session.fork', { session: 's1' });
  await flush();
  sock.close();
  assert.equal((await pending).error.code, 'failed');
  assert.equal(h.client.status(), 'connecting');
  assert.equal(h.timers.length, 1);
  await h.timers[0].fn();
  assert.deepEqual(h.fetched, ['/deck', '/deck']);
});

test('refresh picks up a changed action list', async () => {
  const descriptor = { ...DECK };
  const h = harness(descriptor);
  await h.client.start();
  FakeSocket.all[0].open();
  assert.equal(h.client.supports('ext.demo.go'), false);
  descriptor.actions = [...DECK.actions, 'ext.demo.go'];
  await h.client.refresh();
  assert.equal(h.client.supports('ext.demo.go'), true);
});

test('stateToGraph lifts settings, status and extension state to the top level, and keeps history absent when absent', () => {
  const g = stateToGraph({
    type: 'state', rev: 9, sessions: [{ sessionId: 'a' }], nodes: [], edges: [], tasks: null, schedules: [],
    settings: { autoUpdate: 'notify' }, status: { codeVersion: 'abc' }, ext: { todos: { todos: { a: [] } } }, generatedAt: 1,
  });
  assert.deepEqual(g, {
    sessions: [{ sessionId: 'a' }], nodes: [], edges: [], tasks: null, schedules: [], generatedAt: 1,
    autoUpdate: 'notify', codeVersion: 'abc', todos: { a: [] },
  });
  assert.equal('history' in g, false);
  assert.deepEqual(stateToGraph({ type: 'state', rev: 1, history: [] }).history, []);
});

test('supportedItems drops unsupported items and the separators they leave behind', () => {
  const items = [
    { label: 'Rename', action: 'session.rename' },
    { label: 'Copy' },
    { sep: true },
    { label: 'Fork', action: 'session.fork' },
    { sep: true },
    { label: 'Archive', action: 'session.archive' },
  ];
  const kept = supportedItems(items, (a) => a === 'session.archive');
  assert.deepEqual(kept.map((i) => i.label ?? '—'), ['Copy', '—', 'Archive']);
  assert.deepEqual(supportedItems(items, () => false).map((i) => i.label ?? '—'), ['Copy']);
});

// app.js can't be imported under node:test (it touches WebSocket/xterm/the DOM
// at import — see module-syntax.test.js), so its half of the history contract is
// pinned statically: a state frame leaves history out while it is unchanged, and
// `graph.history || []` would read that as an empty archive.
test('the board reads history by PRESENCE, so an omitted key never clears the list', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /'history' in graph/, 'applyGraph must test for the key, not read it');
  assert.equal(/^\s*latestHistory = graph\.history/m.test(app), false, 'an unguarded assignment reads "unchanged" as "now empty"');
});
