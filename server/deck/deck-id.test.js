import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDeckId } from './deck-id.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aw-deck-id-'));

test('a deck id is minted on first start and kept in the state dir', () => {
  const dir = tmp();
  const first = loadDeckId(dir);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'deck.json'), 'utf8')), { deckId: first });
  assert.equal(loadDeckId(dir, { mint: () => 'never-used-id' }), first);
});

test('an unusable stored id is replaced', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'deck.json'), JSON.stringify({ deckId: 'x' }));
  assert.equal(loadDeckId(dir, { mint: () => 'fresh-deck-id' }), 'fresh-deck-id');
});
