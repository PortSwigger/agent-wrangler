import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeckClient } from './deck-client.js';
import { deckIdOf, stampDeck } from './card-key.js';
import { createDeckList, createRemoteDecks, deckLabel, extensionDecks, mergeDeckGraphs, originOfUrl, remoteTaskView, routeDeck, scopeCall, scopeReply } from './decks.js';

const flush = () => new Promise((r) => setImmediate(r));

// Two fake decks behind one fake network: each URL answers GET /deck with its
// own descriptor and opens its own sockets, and `down` makes one unreachable.
function network(descriptors) {
  const sockets = [];
  const down = new Set();
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const timers = [];
  const makeClient = (opts) => createDeckClient({
    ...opts,
    fetchImpl: async (url) => {
      const origin = new URL(url).origin;
      if (down.has(origin) || !descriptors[origin]) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => descriptors[origin] };
    },
    WebSocketImpl: FakeSocket,
    setTimer: (fn) => timers.push(fn),
  });
  const socketOf = (origin) => sockets.filter((s) => s.url.startsWith(origin.replace(/^http/, 'ws')) && s.readyState === 1).at(-1);
  const runTimers = async () => { const due = timers.splice(0); for (const fn of due) await fn(); await flush(); };
  return { makeClient, sockets, socketOf, down, runTimers };
}

const desc = (deckId, name) => ({ deckId, name, api: '1.0', actions: ['session.archive', 'session.chat', 'session.file'] });
const stateFrame = (sessions) => ({ type: 'state', rev: 1, sessions });

test('a remote deck\'s URL becomes its HTTP and WebSocket origins', () => {
  assert.deepEqual(originOfUrl('http://127.0.0.1:7890'), { http: 'http://127.0.0.1:7890', ws: 'ws://127.0.0.1:7890' });
  assert.deepEqual(originOfUrl('https://deck.example.com'), { http: 'https://deck.example.com', ws: 'wss://deck.example.com' });
});

test('a deck is called by its given name, else its descriptor\'s, else its URL', () => {
  assert.equal(deckLabel({ name: 'Desk', url: 'http://a:1' }, { name: 'host' }), 'Desk');
  assert.equal(deckLabel({ name: '', url: 'http://a:1' }, { name: 'host' }), 'host');
  assert.equal(deckLabel({ url: 'http://a:1' }), 'a:1');
});

test('with one deck the merged graph is the own deck\'s, with no deck fields added', () => {
  const graph = stampDeck({ sessions: [{ sessionId: 's1' }], tasks: { tasks: [] }, autoUpdate: 'notify' }, 'own-deck');
  const merged = mergeDeckGraphs({ graph, name: 'Mine', colour: '#4f8cff', status: 'unreachable' }, [], { multi: false });
  assert.deepEqual(merged, graph);
});

test('two decks holding the same session id give two cards, each named by its deck', () => {
  const own = { graph: stampDeck({ sessions: [{ sessionId: 'same', label: 'A' }], autoUpdate: 'notify' }, 'deck-a'), name: 'Laptop A', colour: '#4f8cff', status: 'ready' };
  const remote = { graph: stampDeck({ sessions: [{ sessionId: 'same', label: 'B' }], autoUpdate: 'off' }, 'deck-b'), name: 'Laptop B', colour: '#e5793b', status: 'ready' };
  const merged = mergeDeckGraphs(own, [remote], { multi: true });
  assert.deepEqual(merged.sessions.map((s) => [s.cardKey, s.label, s.deckName, s.deckColour]), [
    ['deck-a/same', 'A', 'Laptop A', '#4f8cff'],
    ['deck-b/same', 'B', 'Laptop B', '#e5793b'],
  ]);
  assert.equal(merged.autoUpdate, 'notify', 'board-wide state is the own deck\'s');
  assert.ok(merged.sessions.every((s) => !s.deckUnreachable));
});

test('a deck that is not connected keeps its cards, marked unreachable', () => {
  const own = { graph: { sessions: [] }, status: 'ready' };
  const remote = { graph: stampDeck({ sessions: [{ sessionId: 'b1' }] }, 'deck-b'), name: 'B', status: 'unreachable' };
  assert.equal(mergeDeckGraphs(own, [remote], { multi: true }).sessions[0].deckUnreachable, true);
  assert.equal(mergeDeckGraphs(own, [{ ...remote, status: 'ready' }], { multi: true }).sessions[0].deckUnreachable, undefined);
});

test('a call goes to the deck its card names; a bare session id goes to the one deck holding it', () => {
  const sessions = [{ sessionId: 'a1', deckId: 'deck-a' }, { sessionId: 'b1', deckId: 'deck-b' }, { sessionId: 'same', deckId: 'deck-a' }, { sessionId: 'same', deckId: 'deck-b' }];
  const route = (o) => routeDeck({ sessions, own: 'deck-a', deckIdOf, ...o });
  assert.equal(route({ card: 'deck-b/same' }), 'deck-b');
  assert.equal(route({ sessionId: 'b1' }), 'deck-b');
  assert.equal(route({ sessionId: 'a1', context: 'deck-b' }), 'deck-a', 'the holder wins over the reply context');
  assert.equal(route({ sessionId: 'same', hint: 'deck-b/same' }), 'deck-b', 'a shared id follows the card acted on');
  assert.equal(route({ sessionId: 'same', hint: 'deck-b/other' }), 'deck-a', 'a hint for another session does not apply');
  assert.equal(route({ sessionId: 'same', context: 'deck-b' }), 'deck-b');
  assert.equal(route({ sessionId: 'same' }), 'deck-a');
  assert.equal(route({}), 'deck-a', 'a call naming no session goes to the own deck');
  assert.equal(route({ context: 'deck-b' }), 'deck-b');
});

test('each remote deck gets its own client; an action on its card reaches only that deck', async () => {
  const net = network({ 'http://127.0.0.1:7001': desc('deck-b', 'B'), 'http://127.0.0.1:7002': desc('deck-c', 'C') });
  let changes = 0;
  const remotes = createRemoteDecks({ makeClient: net.makeClient, ownDeckId: () => 'deck-a', onChange: () => { changes++; } });
  remotes.sync([{ id: 'own', own: true }, { id: 'b', url: 'http://127.0.0.1:7001', name: 'Laptop B', colour: '#e5793b' }, { id: 'c', url: 'http://127.0.0.1:7002', name: '', colour: '#3fae6a' }]);
  await flush(); await flush();
  assert.deepEqual(remotes.list().map((d) => [d.id, d.deckId, d.status, d.name]), [['b', 'deck-b', 'ready', 'Laptop B'], ['c', 'deck-c', 'ready', 'C']]);
  net.socketOf('http://127.0.0.1:7001').receive(stateFrame([{ sessionId: 'same' }]));
  net.socketOf('http://127.0.0.1:7002').receive(stateFrame([{ sessionId: 'same' }]));
  assert.deepEqual(remotes.list().map((d) => d.graph.sessions[0].cardKey), ['deck-b/same', 'deck-c/same']);
  assert.ok(changes > 0);

  remotes.clientFor('deck-c').act('session.archive', { session: 'same', args: { sessionId: 'same' } });
  await flush();
  assert.deepEqual(net.socketOf('http://127.0.0.1:7001').sent, [], 'deck B heard nothing');
  assert.deepEqual(net.socketOf('http://127.0.0.1:7002').sent.map((f) => [f.action, f.session]), [['session.archive', 'same']]);
  assert.deepEqual(remotes.originFor('deck-b'), { http: 'http://127.0.0.1:7001', ws: 'ws://127.0.0.1:7001' });
  assert.equal(remotes.clientFor('deck-a'), null, 'the own deck is not a remote one');
});

test('a stopped deck turns unreachable and keeps its cards; when it comes back they are live again', async () => {
  const net = network({ 'http://127.0.0.1:7001': desc('deck-b', 'B') });
  const remotes = createRemoteDecks({ makeClient: net.makeClient, ownDeckId: () => 'deck-a' });
  remotes.sync([{ id: 'b', url: 'http://127.0.0.1:7001' }]);
  await flush(); await flush();
  net.socketOf('http://127.0.0.1:7001').receive(stateFrame([{ sessionId: 'b1' }]));
  net.down.add('http://127.0.0.1:7001');
  net.socketOf('http://127.0.0.1:7001').close();
  await net.runTimers();
  const [down] = remotes.list();
  assert.equal(down.status, 'unreachable');
  assert.equal(mergeDeckGraphs({ graph: { sessions: [] }, status: 'ready' }, remotes.list(), { multi: true }).sessions[0].deckUnreachable, true);
  net.down.delete('http://127.0.0.1:7001');
  await net.runTimers(); await flush();
  assert.equal(remotes.list()[0].status, 'ready');
  assert.equal(mergeDeckGraphs({ graph: { sessions: [] }, status: 'ready' }, remotes.list(), { multi: true }).sessions[0].deckUnreachable, undefined);
});

test('a URL that reaches a deck already on the board is shown as a duplicate and not read', async () => {
  const net = network({ 'http://127.0.0.1:7001': desc('deck-a', 'A'), 'http://localhost:7002': desc('deck-b', 'B'), 'http://127.0.0.1:7002': desc('deck-b', 'B') });
  const remotes = createRemoteDecks({ makeClient: net.makeClient, ownDeckId: () => 'deck-a' });
  remotes.sync([{ id: 'x', url: 'http://127.0.0.1:7001' }, { id: 'b', url: 'http://127.0.0.1:7002' }, { id: 'b2', url: 'http://localhost:7002' }]);
  await flush(); await flush();
  assert.deepEqual(remotes.list().map((d) => [d.id, d.status, d.duplicate]), [['x', 'incompatible', 'own'], ['b', 'ready', null], ['b2', 'incompatible', 'b']]);
});

test('removing a deck from the list stops its client; renaming applies in place', async () => {
  const net = network({ 'http://127.0.0.1:7001': desc('deck-b', 'B') });
  const remotes = createRemoteDecks({ makeClient: net.makeClient, ownDeckId: () => 'deck-a' });
  remotes.sync([{ id: 'b', url: 'http://127.0.0.1:7001', name: 'One' }]);
  await flush(); await flush();
  remotes.sync([{ id: 'b', url: 'http://127.0.0.1:7001', name: 'Two' }]);
  assert.equal(remotes.list()[0].name, 'Two');
  assert.equal(net.sockets.length, 1, 'a rename does not reconnect');
  remotes.sync([]);
  assert.deepEqual(remotes.list(), []);
  assert.equal(net.sockets[0].readyState, 3);
});

test('the deck list follows the board server, so every browser shows the same list', async () => {
  const sources = [];
  class FakeEventSource { constructor(url) { this.url = url; sources.push(this); } close() {} }
  let server = { rev: 1, decks: [{ id: 'own', own: true }] };
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push(JSON.parse(opts.body));
      server = { rev: server.rev + 1, decks: [...server.decks, { id: 'b', url: 'http://127.0.0.1:7001' }] };
      for (const s of sources) s.onmessage({ data: JSON.stringify(server) });
      return { ok: true, json: async () => server };
    }
    return { ok: true, json: async () => server };
  };
  const seenA = [];
  const seenB = [];
  const a = createDeckList({ fetchImpl, EventSourceImpl: FakeEventSource, onList: (l) => seenA.push(l) });
  const b = createDeckList({ fetchImpl, EventSourceImpl: FakeEventSource, onList: (l) => seenB.push(l) });
  a.start(); b.start();
  await flush();
  assert.deepEqual(sources.map((s) => s.url), ['/api/decks/stream', '/api/decks/stream']);
  await a.change({ op: 'add', url: 'http://127.0.0.1:7001' });
  assert.deepEqual(posts, [{ op: 'add', url: 'http://127.0.0.1:7001' }]);
  assert.deepEqual(seenA.at(-1), seenB.at(-1));
  assert.equal(seenB.at(-1).length, 2);
});

test('a refused change rejects with the board server\'s reason', async () => {
  const list = createDeckList({ fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'That deck is already on this board' }) }), EventSourceImpl: null });
  await assert.rejects(list.change({ op: 'add', url: 'x' }), /already on this board/);
});

test('a deck that is down when the page loads still shows its last cards, unreachable', async () => {
  const store = new Map();
  const cache = { get: (e) => store.get(e.id) ?? null, set: (e, v) => store.set(e.id, v), drop: (e) => store.delete(e.id) };
  const net = network({ 'http://127.0.0.1:7001': desc('deck-b', 'B') });
  const first = createRemoteDecks({ makeClient: net.makeClient, ownDeckId: () => 'deck-a', cache });
  first.sync([{ id: 'b', url: 'http://127.0.0.1:7001' }]);
  await flush(); await flush();
  net.socketOf('http://127.0.0.1:7001').receive(stateFrame([{ sessionId: 'b1', label: 'kept' }]));
  first.stop();

  net.down.add('http://127.0.0.1:7001');
  const reloaded = createRemoteDecks({ makeClient: net.makeClient, ownDeckId: () => 'deck-a', cache });
  reloaded.sync([{ id: 'b', url: 'http://127.0.0.1:7001' }]);
  await flush(); await flush();
  const merged = mergeDeckGraphs({ graph: { sessions: [] }, status: 'ready' }, reloaded.list(), { multi: true });
  assert.deepEqual(merged.sessions.map((s) => [s.cardKey, s.label, s.deckUnreachable]), [['deck-b/b1', 'kept', true]]);
  assert.equal(reloaded.list()[0].status, 'unreachable');
  reloaded.sync([]);
  assert.equal(store.size, 0, 'removing the deck forgets its cards');
});

test('each extension is listed with every deck reporting it: ready, incompatible on another boardApi, or unreachable', () => {
  const descriptor = (exts) => ({ extensions: exts.map(([id, boardApi]) => ({ id, version: null, boardApi })) });
  const decks = [
    { deckId: 'deck-a', name: 'Laptop A', colour: '#e5793b', own: true, status: 'ready', descriptor: descriptor([['probe', '^1.81.0'], ['todos', '^1.74.0']]), ext: { probe: { count: 1 } } },
    { deckId: 'deck-b', name: 'Laptop B', colour: null, status: 'ready', descriptor: descriptor([['probe', '^1.76.0']]), ext: { probe: { count: 9 } } },
    { deckId: 'deck-c', name: 'Laptop C', colour: null, status: 'unreachable', descriptor: descriptor([['probe', '^1.81.0']]), ext: { probe: { count: 4 } } },
    { deckId: 'deck-d', name: 'Copy of A', status: 'incompatible', duplicate: 'own', descriptor: descriptor([['probe', '^1.81.0']]) },
    { deckId: 'deck-e', name: 'Not yet', status: 'connecting', descriptor: null },
  ];
  const got = extensionDecks(decks, (id) => ({ probe: '^1.81.0' })[id] ?? null);
  assert.deepEqual(got.get('probe'), [
    { deckId: 'deck-a', name: 'Laptop A', colour: '#e5793b', own: true, status: 'ready', boardApi: '^1.81.0', state: { count: 1 } },
    { deckId: 'deck-b', name: 'Laptop B', colour: null, own: false, status: 'incompatible', boardApi: '^1.76.0', state: null },
    { deckId: 'deck-c', name: 'Laptop C', colour: null, own: false, status: 'unreachable', boardApi: '^1.81.0', state: { count: 4 } },
  ]);
  assert.deepEqual(got.get('todos').map((r) => [r.deckId, r.status]), [['deck-a', 'ready']], 'an extension with no board half here pairs with any deck');
});

test('a remote deck keeps its own extension state from its state frames', async () => {
  const net = network({ 'http://127.0.0.1:7001': desc('deck-b', 'B') });
  const remotes = createRemoteDecks({ makeClient: net.makeClient, ownDeckId: () => 'deck-a' });
  remotes.sync([{ id: 'own', own: true }, { id: 'b', url: 'http://127.0.0.1:7001', name: 'Laptop B' }]);
  await flush(); await flush();
  net.socketOf('http://127.0.0.1:7001').receive({ ...stateFrame([]), ext: { probe: { count: 2 } } });
  assert.deepEqual(remotes.list()[0].ext, { probe: { count: 2 } });
});

test('another deck\'s tasks and schedules are scoped by its deck id and carry its name', () => {
  const graph = {
    sessions: [],
    tasks: { tasks: [{ id: 't_1', name: 'Pipeline' }, { id: 't_2', name: 'Old', archivedAt: 1 }], order: ['t_2', 'adhoc', 't_1', 'gone'], assignments: { s1: 't_1', s2: 'nope' }, sessionOrder: { t_1: ['s1'] } },
    schedules: { schedules: [{ id: 'sch_1', name: 'Nightly', enabled: true }] },
  };
  const view = remoteTaskView([
    { deckId: 'deck-b', name: 'Laptop B', colour: '#112233', status: 'ready', graph },
    { deckId: 'deck-c', name: 'Laptop C', colour: null, status: 'unreachable', graph: { tasks: { tasks: [{ id: 't_1', name: 'Same id' }] } } },
    { deckId: null, name: 'Connecting', graph },
  ]);
  assert.deepEqual(view.tasks.map((t) => [t.id, t.name, t.deckName, Boolean(t.deckUnreachable)]), [
    ['deck-b/t_1', 'Pipeline', 'Laptop B', false], ['deck-b/t_2', 'Old', 'Laptop B', false], ['deck-c/t_1', 'Same id', 'Laptop C', true],
  ]);
  assert.deepEqual(view.order, ['deck-b/t_2', 'deck-b/t_1', 'deck-c/t_1'], 'each deck\'s own order, decks kept together');
  assert.deepEqual(view.assignments, { 'deck-b/s1': 'deck-b/t_1' });
  assert.deepEqual(view.sessionOrder, { 'deck-b/t_1': ['s1'] });
  assert.deepEqual(view.schedules.map((s) => [s.id, s.localId, s.deckName]), [['deck-b/sch_1', 'sch_1', 'Laptop B']]);
  assert.deepEqual(remoteTaskView([]).tasks, []);
});

test('a task or schedule call goes to the deck its id names, bare; naming two decks is a conflict', () => {
  assert.deepEqual(scopeCall({ type: 'task-rename', taskId: 'deck-b/t_1', name: 'X' }), { deckId: 'deck-b', frame: { type: 'task-rename', taskId: 't_1', name: 'X' } });
  assert.deepEqual(scopeCall({ type: 'task-rename', taskId: 't_1' }), { deckId: null, frame: { type: 'task-rename', taskId: 't_1' } });
  assert.deepEqual(scopeCall({ type: 'schedule-toggle', id: 'deck-b/sch_1', enabled: false }).frame, { type: 'schedule-toggle', id: 'sch_1', enabled: false });
  assert.equal(scopeCall({ type: 'task-assign', sessionId: 's1', taskId: null }).deckId, undefined, 'unassigning names no deck');
  assert.equal(scopeCall({ type: 'task-reorder', taskId: 'deck-b/t_1', targetId: 'adhoc' }).conflict, true);
  assert.equal(scopeCall({ type: 'task-reorder', taskId: 'deck-b/t_1', targetId: 'deck-b/t_2' }).frame.targetId, 't_2');
  assert.equal(scopeCall({ type: 'launch', taskId: 'deck-b/t_1' }).deckId, undefined, 'only task and schedule calls are scoped');
  assert.deepEqual(scopeReply({ type: 'task-created', taskId: 't_9' }, 'deck-b'), { type: 'task-created', taskId: 'deck-b/t_9' });
  assert.deepEqual(scopeReply({ type: 'task-created', taskId: 't_9' }, null), { type: 'task-created', taskId: 't_9' });
});
