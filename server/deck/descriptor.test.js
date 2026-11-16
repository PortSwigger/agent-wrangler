import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckDescriptor, wsApiMode } from './descriptor.js';

test('the descriptor carries the id, api 1.0, sorted actions and enabled extensions only', () => {
  const d = deckDescriptor({
    deckId: 'd1',
    name: 'laptop',
    actions: new Set(['task.create', 'deck.search']).keys(),
    runtimes: [{ id: 'local', label: 'Local', agents: null, extra: 1 }],
    extensions: [{ id: 'todos', enabled: true, version: '1.2.0' }, { id: 'off', enabled: false }],
    boardApi: '1.73.0',
  });
  assert.deepEqual(d, {
    deckId: 'd1',
    name: 'laptop',
    api: '1.1',
    runtimes: [{ id: 'local', label: 'Local', agents: null }],
    offeredRuntimes: null,
    actions: ['deck.search', 'task.create'],
    extensions: [{ id: 'todos', version: '1.2.0', boardApi: '1.73.0' }],
    extensionInstalls: true,
  });
});

test('the descriptor says when extension installs are off on the deck', () => {
  const d = deckDescriptor({ deckId: 'd1', name: 'pod', actions: [], runtimes: [], extensions: [], extensionInstalls: false, boardApi: '1.73.0' });
  assert.equal(d.extensionInstalls, false);
});

test('/ws?api= picks the legacy protocol, the deck API, or refuses a major it cannot serve', () => {
  assert.equal(wsApiMode(''), 'legacy');
  assert.equal(wsApiMode('?api=1'), 'deck');
  assert.equal(wsApiMode('?api=1.0'), 'deck');
  assert.equal(wsApiMode('?api=2'), null);
  assert.equal(wsApiMode('?api=x'), null);
});

test('each extension is listed with its own boardApi, else the one the deck serves', () => {
  const d = deckDescriptor({
    deckId: 'd1',
    name: 'laptop',
    actions: [],
    runtimes: [],
    extensions: [{ id: 'split', enabled: true, version: '2.0.0', boardApi: '^1.74.0' }, { id: 'plain', enabled: true }],
    boardApi: '1.74.0',
  });
  assert.deepEqual(d.extensions, [{ id: 'split', version: '2.0.0', boardApi: '^1.74.0' }, { id: 'plain', version: null, boardApi: '1.74.0' }]);
});

test('a location runtime carries location, and one the deck will not launch on says why', () => {
  const d = deckDescriptor({
    deckId: 'd1',
    name: 'laptop',
    actions: [],
    runtimes: [{ id: 'local', label: 'Local', agents: null, location: false }, { id: 'box', label: 'Box', agents: ['claude'], location: true, unavailable: 'Mixed deck.' }],
    extensions: [],
    boardApi: '1.87.0',
  });
  assert.deepEqual(d.runtimes, [{ id: 'local', label: 'Local', agents: null }, { id: 'box', label: 'Box', agents: ['claude'], location: true, unavailable: 'Mixed deck.' }]);
});

test('offeredRuntimes reports the ids the deck was started with, or null for every runtime', () => {
  const base = { deckId: 'd1', name: 'laptop', actions: [], runtimes: [], extensions: [], boardApi: '1.87.0' };
  assert.equal(deckDescriptor(base).offeredRuntimes, null);
  const picked = ['box'];
  const d = deckDescriptor({ ...base, offeredRuntimes: picked });
  assert.deepEqual(d.offeredRuntimes, ['box']);
  assert.notEqual(d.offeredRuntimes, picked);
});
