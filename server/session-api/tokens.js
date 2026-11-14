import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonOrLoud } from '../atomic-json.js';

const TOKEN_PREFIX = 'awt_';

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// One random token per card, re-issued at every launch of that card (dispatch,
// resume, fork). Only the SHA-256 of each token is kept, in memory and in
// `file` (0600), so the file never holds a usable credential and a server
// restart still recognises every live session's token.
export function createTokenStore({ file, randomBytes = crypto.randomBytes, onError = () => {} }) {
  const byCard = new Map();
  const byHash = new Map();

  const saved = readJsonOrLoud(file, 'session tokens');
  for (const [cardId, hash] of Object.entries(saved?.cards || {})) {
    if (typeof hash !== 'string') continue;
    byCard.set(cardId, hash);
    byHash.set(hash, cardId);
  }

  function save(cards = byCard) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify({ cards: Object.fromEntries(cards) }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  }

  function drop(cardId) {
    const old = byCard.get(cardId);
    if (old === undefined) return false;
    byCard.delete(cardId);
    byHash.delete(old);
    return true;
  }

  return {
    // Throws when the token cannot be saved: a launch must fail rather than run
    // with a token the next server start would not know.
    issue(cardId) {
      const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const hash = hashToken(token);
      save(new Map(byCard).set(cardId, hash));
      drop(cardId);
      byCard.set(cardId, hash);
      byHash.set(hash, cardId);
      return token;
    },
    cardFor(token) {
      if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
      return byHash.get(hashToken(token)) ?? null;
    },
    hasToken(cardId) {
      return byCard.has(cardId);
    },
    revoke(cardId) {
      if (!drop(cardId)) return;
      try { save(); } catch (err) { onError('[session-api] saving session tokens failed', err); }
    },
  };
}
