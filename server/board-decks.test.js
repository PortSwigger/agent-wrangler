import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBoardDecks, normalizeDeckUrl, sanitizeDecks, DECK_COLOURS } from './board-decks.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-board-decks-')), 'board-decks.json');

test('a fresh board lists only its own deck', () => {
  const store = createBoardDecks({ file: tmpFile() });
  assert.deepEqual(store.list().decks, [{ id: 'own', own: true, name: '', colour: DECK_COLOURS[0] }]);
});

test('a deck URL is reduced to its origin, and only http(s) is taken', () => {
  assert.equal(normalizeDeckUrl(' http://127.0.0.1:7890/deck?x=1 '), 'http://127.0.0.1:7890');
  assert.equal(normalizeDeckUrl('https://deck.example.com'), 'https://deck.example.com');
  assert.equal(normalizeDeckUrl('ws://127.0.0.1:7890'), null);
  assert.equal(normalizeDeckUrl('javascript:alert(1)'), null);
  assert.equal(normalizeDeckUrl('http://user:pw@127.0.0.1:1'), null);
  assert.equal(normalizeDeckUrl('not a url'), null);
});

test('add, rename, recolour and remove persist and announce each change', () => {
  const file = tmpFile();
  const seen = [];
  const store = createBoardDecks({ file, onChange: (s) => seen.push(s) });
  const added = store.apply({ op: 'add', url: 'http://127.0.0.1:7890', name: 'Laptop B' });
  const remote = added.decks[1];
  assert.equal(remote.url, 'http://127.0.0.1:7890');
  assert.equal(remote.name, 'Laptop B');
  assert.equal(remote.colour, DECK_COLOURS[1], 'the next unused colour');
  assert.ok(store.apply({ op: 'add', url: 'http://127.0.0.1:7890/' }).error, 'the same deck twice is refused');
  store.apply({ op: 'update', id: remote.id, name: 'Desk', colour: '#ABCDEF' });
  store.apply({ op: 'update', id: 'own', name: 'Mine' });
  assert.ok(store.apply({ op: 'update', id: remote.id, colour: 'red' }).error);
  assert.deepEqual(createBoardDecks({ file }).list().decks.map(({ id, name, colour }) => ({ id, name, colour })), [
    { id: 'own', name: 'Mine', colour: DECK_COLOURS[0] },
    { id: remote.id, name: 'Desk', colour: '#abcdef' },
  ]);
  assert.ok(store.apply({ op: 'remove', id: 'own' }).error, 'the own deck cannot be removed');
  store.apply({ op: 'remove', id: remote.id });
  assert.equal(store.list().decks.length, 1);
  assert.equal(seen.length, 4);
  assert.ok(seen.every((s, i) => i === 0 || s.rev > seen[i - 1].rev), 'each change moves the revision on');
});

test('a hand-edited file is read back into a valid list', () => {
  const decks = sanitizeDecks([
    { url: 'http://127.0.0.1:1', name: 'x'.repeat(80), colour: '<b>' },
    { url: 'http://127.0.0.1:1/' },
    { url: 'file:///etc/passwd' },
    null,
    { own: true, colour: '#000000' },
  ]);
  assert.equal(decks.length, 2);
  assert.deepEqual(decks[0], { id: 'own', own: true, name: '', colour: '#000000' });
  assert.equal(decks[1].name.length, 40);
  assert.match(decks[1].colour, /^#[0-9a-f]{6}$/);
});
