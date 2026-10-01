import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../../../data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from '../../../atomic-json.js';

export const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
export const ADHOC = 'adhoc';

// Board TODOs, keyed by bucket (a task id or 'adhoc'). On disk:
//   { migrated: true, todos: { <bucket>: [{id, text, description?, createdAt}, …] } }
// The map is sparse: a bucket key exists only while its list is non-empty.
// A TODO is un-started intent that a spawn consumes, keyed by task exactly like
// sessionOrder but not linked to one. This store cannot know which buckets are
// real (no task list), so callers pass buckets they have already validated.
export class TodoStore {
  constructor(file = TODOS_FILE) {
    this.file = file;
    this.todos = {};
    this.migrated = false;
    this._load();
  }

  _load() {
    const raw = readJsonOrLoud(this.file, 'todos.json');
    if (!raw || typeof raw !== 'object') return;
    this.migrated = raw.migrated === true;
    this.todos = sanitize(raw.todos);
  }

  _save() {
    writeJsonAtomic(this.file, { migrated: true, todos: this.todos });
    this.migrated = true;
  }

  // Replace everything (the one-shot import) and persist, marked migrated.
  replaceAll(todos) {
    this.todos = sanitize(todos);
    this._save();
  }

  snapshot() {
    return { todos: Object.fromEntries(Object.entries(this.todos).map(([k, v]) => [k, v.map((td) => ({ ...td }))])) };
  }

  // Blank text is a no-op (null). null taskId maps to ADHOC.
  addTodo(taskId, text, createdAt = Date.now(), description = '') {
    const bucket = taskId || ADHOC;
    const trimmed = (text || '').trim();
    if (!trimmed) return null;
    const todo = { id: `td_${crypto.randomBytes(4).toString('hex')}`, text: trimmed, createdAt };
    if (description?.trim()) todo.description = description.trim();
    (this.todos[bucket] || (this.todos[bucket] = [])).push(todo);
    this._save();
    return todo;
  }

  // No-op on blank, unchanged, or an unknown todo.
  editTodo(taskId, todoId, text, description) {
    const bucket = taskId || ADHOC;
    const todo = (this.todos[bucket] || []).find((td) => td.id === todoId);
    if (!todo || (text === undefined && description === undefined)) return false;
    const trimmed = text === undefined ? todo.text : (text || '').trim();
    if (!trimmed) return false;
    const nextDescription = description === undefined ? (todo.description || '') : description.trim();
    if (trimmed === todo.text && nextDescription === (todo.description || '')) return false;
    todo.text = trimmed;
    if (nextDescription) todo.description = nextDescription;
    else delete todo.description;
    this._save();
    return true;
  }

  // Keeps the map sparse: deletes the key when the list empties.
  deleteTodo(taskId, todoId) {
    const bucket = taskId || ADHOC;
    const list = this.todos[bucket];
    if (!list) return false;
    const i = list.findIndex((td) => td.id === todoId);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete this.todos[bucket];
    this._save();
    return true;
  }

  // Reassign across buckets. No-op for same bucket or unknown todo. The caller
  // has validated the destination.
  moveTodo(todoId, fromTaskId, toTaskId) {
    const from = fromTaskId || ADHOC, to = toTaskId || ADHOC;
    if (from === to) return false;
    const list = this.todos[from];
    if (!list) return false;
    const i = list.findIndex((td) => td.id === todoId);
    if (i < 0) return false;
    const [todo] = list.splice(i, 1);
    if (!list.length) delete this.todos[from];
    (this.todos[to] || (this.todos[to] = [])).push(todo);
    this._save();
    return true;
  }

  // A todo not mentioned in `order` is appended rather than dropped.
  reorderTodos(taskId, order) {
    const bucket = taskId || ADHOC;
    const list = this.todos[bucket];
    if (!list || !Array.isArray(order)) return false;
    const byId = new Map(list.map((td) => [td.id, td]));
    const seen = new Set();
    const next = [];
    for (const id of order) {
      if (typeof id !== 'string' || seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      next.push(byId.get(id));
    }
    for (const td of list) if (!seen.has(td.id)) next.push(td);
    if (next.length === list.length && next.every((td, i) => td === list[i])) return false;
    this.todos[bucket] = next;
    this._save();
    return true;
  }

  // Drop a whole bucket (its task was deleted). True if there was one.
  dropBucket(id) {
    if (!Object.hasOwn(this.todos, id)) return false;
    delete this.todos[id];
    this._save();
    return true;
  }

  // Drop buckets not in `validIds`; saves only if something changed.
  prune(validIds) {
    let changed = false;
    for (const bucket of Object.keys(this.todos)) {
      if (!validIds.has(bucket)) { delete this.todos[bucket]; changed = true; }
    }
    if (changed) this._save();
    return changed;
  }
}

// Keep only well-formed buckets (a non-array list is dropped) and drop empty
// lists so the map stays sparse.
export function sanitize(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [bucket, list] of Object.entries(raw)) {
      if (Array.isArray(list) && list.length) out[bucket] = list;
    }
  }
  return out;
}
