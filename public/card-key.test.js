import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardKey, parseCardKey, keyOf, sessionIdOf, deckIdOf, stampDeck } from './card-key.js';

const DECK = '6f1c2a9e-0b7d-4c3e-9a51-2f8e4d7c1b60';

test('a card key carries the deck id and the session id, and parses back to both', () => {
  const key = cardKey(DECK, 'sess-1');
  assert.equal(key, `${DECK}/sess-1`);
  assert.deepEqual(parseCardKey(key), { deckId: DECK, sessionId: 'sess-1' });
  assert.equal(deckIdOf(key), DECK);
  assert.equal(sessionIdOf(key), 'sess-1');
  assert.equal(keyOf({ deckId: DECK, sessionId: 'sess-1' }), key);
});

test('the same session id on two decks makes two different cards', () => {
  const a = cardKey('deck-aaaa', 'shared-id');
  const b = cardKey('deck-bbbb', 'shared-id');
  assert.notEqual(a, b);
  assert.equal(sessionIdOf(a), sessionIdOf(b));
});

test('a session id holding a slash survives the round trip, since a deck id never does', () => {
  const key = cardKey(DECK, 'first / session');
  assert.deepEqual(parseCardKey(key), { deckId: DECK, sessionId: 'first / session' });
});

test('no key without both halves, and nothing parses from a string that is not one', () => {
  assert.equal(cardKey(null, 'sess-1'), null);
  assert.equal(cardKey(DECK, ''), null);
  assert.equal(cardKey('has/slash', 'sess-1'), null);
  assert.equal(keyOf(null), null);
  for (const bad of [null, '', 'sess-1', '/sess-1', `${DECK}/`, 'bad deck/sess-1']) {
    assert.equal(parseCardKey(bad), null, String(bad));
    assert.equal(sessionIdOf(bad), null);
  }
});

test('stampDeck gives every session record and session node its deck id and card key', () => {
  const graph = {
    sessions: [{ sessionId: 'a' }, { sessionId: 'b', label: 'B' }],
    nodes: [{ type: 'session', sessionId: 'a' }, { type: 'task', id: 't1' }],
    tasks: { tasks: [] },
  };
  assert.equal(stampDeck(graph, DECK), graph);
  assert.deepEqual(graph.sessions, [
    { sessionId: 'a', deckId: DECK, cardKey: `${DECK}/a` },
    { sessionId: 'b', label: 'B', deckId: DECK, cardKey: `${DECK}/b` },
  ]);
  assert.deepEqual(graph.nodes[0], { type: 'session', sessionId: 'a', deckId: DECK, cardKey: `${DECK}/a` });
  assert.deepEqual(graph.nodes[1], { type: 'task', id: 't1' });
});
