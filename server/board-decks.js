import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The decks one board shows, in the board server's own data dir: every browser
// on the board reads the same list. The board's own deck is always in it, as
// `{ id: 'own', own: true }`, so it can be renamed and recoloured but has no
// URL (the board reaches it through <meta name="aw-deck-port">) and cannot be
// removed. Every other deck is a URL the board's browsers open the deck API on.
export const OWN_DECK_ENTRY = 'own';
export const DECK_COLOURS = ['#4f8cff', '#e5793b', '#3fae6a', '#b061d6', '#d64f6a', '#2fb3b3', '#c9a227', '#7a8699'];
const COLOUR = /^#[0-9a-f]{6}$/;
const NAME_MAX = 40;

export function normalizeDeckUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.origin;
}

const cleanName = (name) => (typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : '');
const cleanColour = (colour) => (typeof colour === 'string' && COLOUR.test(colour.toLowerCase()) ? colour.toLowerCase() : null);

function nextColour(decks) {
  const used = new Set(decks.map((d) => d.colour));
  return DECK_COLOURS.find((c) => !used.has(c)) || DECK_COLOURS[decks.length % DECK_COLOURS.length];
}

// Reads whatever is on disk into a valid list: the own entry first, then each
// remote deck with a usable URL, duplicates dropped.
export function sanitizeDecks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const ownRaw = list.find((d) => d && d.own === true) || {};
  const own = { id: OWN_DECK_ENTRY, own: true, name: cleanName(ownRaw.name), colour: cleanColour(ownRaw.colour) || DECK_COLOURS[0] };
  const out = [own];
  const urls = new Set();
  for (const d of list) {
    if (!d || d.own === true) continue;
    const url = normalizeDeckUrl(d.url);
    if (!url || urls.has(url)) continue;
    urls.add(url);
    const id = typeof d.id === 'string' && /^[a-z0-9]{1,16}$/.test(d.id) && d.id !== OWN_DECK_ENTRY ? d.id : crypto.randomBytes(4).toString('hex');
    out.push({ id, url, name: cleanName(d.name), colour: cleanColour(d.colour) || nextColour(out) });
  }
  return out;
}

// `apply(op)` takes { op: 'add', url, name?, colour? }, { op: 'update', id,
// name?, colour? } or { op: 'remove', id } and returns { decks } or { error }.
export function createBoardDecks({ file, onChange = () => {} }) {
  let decks;
  try { decks = sanitizeDecks(JSON.parse(fs.readFileSync(file, 'utf8')).decks); } catch { decks = sanitizeDecks([]); }
  let rev = 1;

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ decks }, null, 2)}\n`);
    fs.renameSync(tmp, file);
    rev += 1;
    onChange(snapshot());
  }

  const snapshot = () => ({ rev, decks: decks.map((d) => ({ ...d })) });

  function apply(body) {
    const op = body?.op;
    if (op === 'add') {
      const url = normalizeDeckUrl(body.url);
      if (!url) return { error: 'Give the deck\'s URL, like http://127.0.0.1:7890' };
      if (decks.some((d) => d.url === url)) return { error: 'That deck is already on this board' };
      const colour = cleanColour(body.colour) || nextColour(decks);
      decks = [...decks, { id: crypto.randomBytes(4).toString('hex'), url, name: cleanName(body.name), colour }];
      save();
      return snapshot();
    }
    const i = decks.findIndex((d) => d.id === body?.id);
    if (i < 0) return { error: 'No such deck on this board' };
    if (op === 'update') {
      const next = { ...decks[i] };
      if ('name' in body) next.name = cleanName(body.name);
      if ('colour' in body) {
        const colour = cleanColour(body.colour);
        if (!colour) return { error: 'A colour is #rrggbb' };
        next.colour = colour;
      }
      decks = decks.map((d, j) => (j === i ? next : d));
      save();
      return snapshot();
    }
    if (op === 'remove') {
      if (decks[i].own) return { error: 'The board\'s own deck stays on the board' };
      decks = decks.filter((_, j) => j !== i);
      save();
      return snapshot();
    }
    return { error: 'Unknown deck operation' };
  }

  return { list: snapshot, apply };
}
