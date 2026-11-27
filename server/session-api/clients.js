import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonOrLoud } from '../atomic-json.js';
import { hashToken } from './tokens.js';

// Outside MCP clients: a program on this machine that is not a session (a bot
// built on an agent SDK, say) calling /mcp with a token the human minted in
// Settings. Each client has a name, an expiry and the scopes it was given; its
// token, `awc_` + 32 random bytes, is shown once and only its SHA-256 is kept,
// in `file` (0600). Revoking deletes the record. The caller check
// (check.js) accepts a client token only on a loopback-bound session API from a
// loopback peer, and resolves it to `{ client }`, never to a card.
//
// A scope is `<extension id>:<scope id>`, one an enabled extension declares in
// its manifest's `clientScopes`; the store keeps whatever it was minted with and
// the MCP layer offers only tools an enabled extension lists under a held scope.

export const CLIENT_TOKEN_PREFIX = 'awc_';
export const CLIENT_DEFAULT_DAYS = 30;
export const CLIENT_MAX_DAYS = 365;
export const CLIENT_NAME_MAX = 40;
const DAY_MS = 24 * 60 * 60 * 1000;
// Last use is kept in memory on every request and written at most this often,
// so a chatty client does not rewrite the file per call; a use that falls inside
// the window is written when it closes.
const USE_SAVE_MS = 30_000;

export const isClientToken = (token) => typeof token === 'string' && token.startsWith(CLIENT_TOKEN_PREFIX);

const publicView = (rec, at) => ({
  id: rec.id,
  name: rec.name,
  scopes: [...rec.scopes],
  createdAt: rec.createdAt,
  expiresAt: rec.expiresAt,
  expired: rec.expiresAt <= at,
  lastUsedAt: rec.lastUsedAt ?? null,
  lastTool: rec.lastTool ?? null,
});

function cleanName(raw) {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new Error('Give the client a name');
  if (name.length > CLIENT_NAME_MAX) throw new Error(`A client name is at most ${CLIENT_NAME_MAX} characters`);
  if (/[\u0000-\u001f\u007f"]/.test(name)) throw new Error('A client name cannot hold control characters or quotes');
  return name;
}

export function createClientStore({ file, randomBytes = crypto.randomBytes, now = Date.now, setTimer = setTimeout, onError = () => {} }) {
  const byId = new Map();
  const saved = readJsonOrLoud(file, 'outside clients');
  for (const c of Array.isArray(saved?.clients) ? saved.clients : []) {
    if (!c || typeof c.id !== 'string' || typeof c.hash !== 'string' || typeof c.name !== 'string') continue;
    byId.set(c.id, {
      id: c.id,
      name: c.name,
      hash: c.hash,
      scopes: Array.isArray(c.scopes) ? c.scopes.filter((s) => typeof s === 'string') : [],
      createdAt: Number(c.createdAt) || 0,
      expiresAt: Number(c.expiresAt) || 0,
      lastUsedAt: Number(c.lastUsedAt) || null,
      lastTool: typeof c.lastTool === 'string' ? c.lastTool : null,
    });
  }
  let savedAt = 0;
  let pendingUse = null;

  function save(records = byId) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify({ clients: [...records.values()] }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    savedAt = now();
    clearTimeout(pendingUse);
    pendingUse = null;
  }
  const saveQuietly = () => {
    try { save(); } catch (err) { onError('[outside-clients] saving outside clients failed', err); }
  };

  const live = (at = now()) => [...byId.values()].filter((c) => c.expiresAt > at);

  return {
    // `exclusive` is the set of scopes at most one live client may hold. Throws
    // with a sentence for the human on a bad name, scope or expiry, or when the
    // record cannot be saved (a token the next start would not know is useless).
    mint({ name, scopes, days = CLIENT_DEFAULT_DAYS, known = () => true, exclusive = new Set() } = {}) {
      const clean = cleanName(name);
      const at = now();
      if (live(at).some((c) => c.name.toLowerCase() === clean.toLowerCase())) throw new Error(`A client named "${clean}" already exists: revoke it first or pick another name`);
      const list = [...new Set(Array.isArray(scopes) ? scopes : [])];
      if (!list.length) throw new Error('Pick at least one scope');
      for (const s of list) {
        if (typeof s !== 'string' || !known(s)) throw new Error(`Unknown scope ${JSON.stringify(s)}`);
        const holder = exclusive.has(s) && live(at).find((c) => c.scopes.includes(s));
        if (holder) throw new Error(`Only one client may hold ${s}, and "${holder.name}" does: revoke it first`);
      }
      const d = Number(days);
      if (!Number.isInteger(d) || d < 1 || d > CLIENT_MAX_DAYS) throw new Error(`Expiry must be a whole number of days from 1 to ${CLIENT_MAX_DAYS}`);
      const token = CLIENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const rec = { id: `c_${randomBytes(6).toString('hex')}`, name: clean, hash: hashToken(token), scopes: list, createdAt: at, expiresAt: at + d * DAY_MS, lastUsedAt: null, lastTool: null };
      save(new Map(byId).set(rec.id, rec));
      byId.set(rec.id, rec);
      return { client: publicView(rec, at), token };
    },
    list() {
      const at = now();
      return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).map((c) => publicView(c, at));
    },
    get(id) {
      const rec = byId.get(id);
      return rec ? publicView(rec, now()) : null;
    },
    revoke(id) {
      const rec = byId.get(id);
      if (!rec) return null;
      byId.delete(id);
      saveQuietly();
      return publicView(rec, now());
    },
    // `{ client }` for a live client's token, `{ reason }` ('unknown' or
    // 'expired') otherwise. Only a token with the client prefix is looked up.
    resolve(token) {
      if (!isClientToken(token)) return { reason: 'unknown' };
      const hash = hashToken(token);
      const rec = [...byId.values()].find((c) => c.hash === hash);
      if (!rec) return { reason: 'unknown' };
      if (rec.expiresAt <= now()) return { reason: 'expired', name: rec.name };
      return { client: { id: rec.id, name: rec.name, scopes: [...rec.scopes] } };
    },
    // Every request a client makes is a use; a tool call also names the tool.
    noteUse(id, tool = null) {
      const rec = byId.get(id);
      if (!rec) return;
      rec.lastUsedAt = now();
      if (tool) rec.lastTool = tool;
      const wait = USE_SAVE_MS - (rec.lastUsedAt - savedAt);
      if (wait <= 0) saveQuietly();
      else if (!pendingUse) {
        pendingUse = setTimer(() => { pendingUse = null; saveQuietly(); }, wait);
        pendingUse?.unref?.();
      }
    },
  };
}
