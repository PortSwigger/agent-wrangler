import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';

const CHECKLIST_FILE = path.join(DATA_DIR, 'checklists.json');

// Per-session caps. Not in the design spec — added because this is the first
// store an *agent* can grow without a human in the loop, and an unbounded list
// is both a runaway JSON file and an unreadable panel. Checked BEFORE the
// append (same shape as mailbox-store's caps) so a refused add never partially
// lands, and thrown as a plain Error whose message is what the agent/board
// actually sees. No eviction: unlike mail, every item is human-visible state
// nobody asked us to delete.
export const MAX_ITEMS = 100;
export const MAX_TEXT_LENGTH = 500;

// Durable per-session checklist — the list the human sees on the board and the
// launched agent writes through its own MCP tools. Mirrors the mailbox-store /
// task-store mould: state in memory, mutators are SYNCHRONOUS, persistence is a
// side effect of mutation. That is load-bearing here rather than stylistic: the
// human (control WS) and the agent (MCP, served from this same process) both
// write, and an `await` between a read and its write is exactly where one would
// clobber the other. atomic-json gives crash-safe writes, not transactional
// read-modify-write.
//
// On disk: { "<cardId>": [{ id, text, done, createdAt }] }. Keyed on the CARD
// ID, never liveSessionId — the card id is the stable per-session handle every
// other per-session field uses (CLAUDE.md's mental model), and it is what the
// MCP caller identity resolves to.
export class ChecklistStore {
  constructor(file = CHECKLIST_FILE) {
    this.file = file;
    this.items = new Map(); // cardId -> [{id, text, done, createdAt}]
    this._load();
  }

  _load() {
    const raw = readJsonOrLoud(this.file, 'checklists.json');
    if (!raw || typeof raw !== 'object') return; // missing/empty = first run
    for (const [sid, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      this.items.set(sid, list.map((it) => ({
        id: it.id,
        text: String(it.text ?? ''),
        done: Boolean(it.done),
        createdAt: it.createdAt ?? null,
      })));
    }
  }

  _save() {
    writeJsonAtomic(this.file, Object.fromEntries(this.items));
  }

  // Keeps the map sparse: an emptied list drops its key rather than persisting
  // `{"<cardId>": []}` for every session that ever had an item.
  _prune(sessionId, list) {
    if (list.length) this.items.set(sessionId, list);
    else this.items.delete(sessionId);
  }

  // The whole store, as the board's graph payload. Session-scoped but carried on
  // the graph as a snapshot (like taskStore's) rather than per-session enrichment
  // in buildGraph: the only consumer is the one selected session's panel, so
  // there is nothing to enrich per card.
  snapshot() {
    return Object.fromEntries([...this.items].map(([sid, list]) => [sid, list.map((it) => ({ ...it }))]));
  }

  list(sessionId) {
    return (this.items.get(sessionId) || []).map((it) => ({ ...it }));
  }

  // Append one item. Blank text is a no-op (returns null) — matching addTodo,
  // so an empty inline-add commit does nothing rather than erroring. Over-cap
  // throws: the caller is an agent (or a human) who needs to be told why.
  // createdAt is injectable for deterministic tests.
  add(sessionId, text, createdAt = Date.now()) {
    if (!sessionId) return null;
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_TEXT_LENGTH) {
      throw new Error(`Checklist item text is too long (max ${MAX_TEXT_LENGTH} characters).`);
    }
    const list = this.items.get(sessionId) || [];
    if (list.length >= MAX_ITEMS) {
      throw new Error(`This session's checklist is full (max ${MAX_ITEMS} items) — remove some before adding more.`);
    }
    const item = { id: `ck_${crypto.randomBytes(4).toString('hex')}`, text: trimmed, done: false, createdAt };
    list.push(item);
    this._prune(sessionId, list);
    this._save();
    return { ...item };
  }

  // Patch text and/or done on one item. Granular by design (see the spec): a
  // whole-list replace would let an agent's stale read clobber a human edit made
  // seconds earlier. Absent fields are left alone, so `{done:true}` never blanks
  // the text. Returns false for an unknown session/item or a no-op patch.
  update(sessionId, itemId, patch = {}) {
    const list = this.items.get(sessionId);
    const item = list && list.find((it) => it.id === itemId);
    if (!item) return false;
    let changed = false;
    if (patch.text !== undefined) {
      const trimmed = String(patch.text || '').trim();
      if (trimmed.length > MAX_TEXT_LENGTH) {
        throw new Error(`Checklist item text is too long (max ${MAX_TEXT_LENGTH} characters).`);
      }
      if (trimmed && trimmed !== item.text) { item.text = trimmed; changed = true; }
    }
    if (patch.done !== undefined) {
      const done = Boolean(patch.done);
      if (done !== item.done) { item.done = done; changed = true; }
    }
    if (changed) this._save();
    return changed;
  }

  remove(sessionId, itemId) {
    const list = this.items.get(sessionId);
    if (!list) return false;
    const i = list.findIndex((it) => it.id === itemId);
    if (i < 0) return false;
    list.splice(i, 1);
    this._prune(sessionId, list);
    this._save();
    return true;
  }

  // Reorder a session's items to the client-supplied `order` (drag-and-drop).
  // An item not mentioned in `order` is APPENDED rather than dropped — this list
  // is the data itself, not display metadata layered over something else, so a
  // stale client must never be able to delete by omission (same rule as
  // reorderTodos). Returns false on a no-op or unknown session.
  reorder(sessionId, order) {
    const list = this.items.get(sessionId);
    if (!list || !Array.isArray(order)) return false;
    const byId = new Map(list.map((it) => [it.id, it]));
    const seen = new Set();
    const next = [];
    for (const id of order) {
      if (typeof id !== 'string' || seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      next.push(byId.get(id));
    }
    for (const it of list) if (!seen.has(it.id)) next.push(it);
    if (next.length === list.length && next.every((it, i) => it === list[i])) return false;
    this.items.set(sessionId, next);
    this._save();
    return true;
  }

  // Permanently drop a session's whole checklist — only ever called when the
  // card itself is purged from mappings.json. Archive is "set aside", not
  // end-of-life, so an archived card keeps its list and a resume restores it.
  forget(sessionId) {
    if (this.items.delete(sessionId)) this._save();
  }
}
