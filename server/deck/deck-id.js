import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonOrLoud, writeJsonAtomic } from '../atomic-json.js';

const ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

// The deck's stable identity: minted on first start and kept in the state
// directory, so a board that knows several decks can tell them apart across
// restarts. Called once, after the instance lock is held.
export function loadDeckId(dataDir, { mint = () => crypto.randomUUID() } = {}) {
  const file = path.join(dataDir, 'deck.json');
  const stored = readJsonOrLoud(file, 'deck.json');
  if (typeof stored?.deckId === 'string' && ID_SHAPE.test(stored.deckId)) return stored.deckId;
  const deckId = mint();
  writeJsonAtomic(file, { ...(stored && typeof stored === 'object' ? stored : {}), deckId }, { trailingNewline: true });
  return deckId;
}
