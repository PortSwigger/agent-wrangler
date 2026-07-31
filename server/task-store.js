import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

const MAX_TASKS = 19;

// The synthetic Ad-hoc tile (unassigned sessions) participates in `order` as a
// reserved id so it reorders exactly like a real task; it has no entry in
// `tasks` and can't be renamed or deleted.
export const ADHOC = 'adhoc';

// Durable, user-owned grouping of sessions. `order` is the display/packing order
// — task ids interleaved with the single `ADHOC` sentinel — while `tasks` just
// holds each real task's metadata. Each tile's size is derived from its live
// session count at render time, not stored here. On disk:
//   { tasks: [{id, name}], order: [taskId | 'adhoc', …],
//     assignments: {sessionId: taskId},
//     sessionOrder: {taskId | 'adhoc': [sessionId, …]},
//     todos: {taskId | 'adhoc': [{id, text, createdAt}, …]} }
// The 'adhoc' sessionOrder/todos key (when present) belongs to the unassigned tile.
// A TODO is the cheapest tier of work — pure un-started intent that a spawn
// consumes — so it is keyed by task exactly like sessionOrder, not linked to one.
export class TaskStore {
  constructor(file = TASKS_FILE) {
    this.file = file;
    this.tasks = [];
    this.order = [ADHOC];
    this.assignments = {};
    this.sessionOrder = {};
    this.todos = {};
    this._load();
  }

  // Drop unknown/duplicate ids, append any tasks missing from a stored order,
  // and guarantee the Ad-hoc sentinel is present (defaulting last — matching the
  // pre-movable pinned position).
  _reconcileOrder(stored) {
    const valid = new Set([...this.tasks.map((t) => t.id), ADHOC]);
    const order = [...new Set((Array.isArray(stored) ? stored : []).filter((id) => valid.has(id)))];
    for (const t of this.tasks) if (!order.includes(t.id)) order.push(t.id);
    if (!order.includes(ADHOC)) order.push(ADHOC);
    return order;
  }

  _load() {
    const raw = readJsonOrLoud(this.file, 'tasks.json');
    if (!raw) return; // missing/empty = first run; corrupt already logged + backed up
    let tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    // Migrate the old slot-based format: preserve order by slot, drop the field.
    if (tasks.some((t) => typeof t.slot === 'number')) {
      tasks = [...tasks].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    }
    this.tasks = tasks.map((t) => ({ id: t.id, name: t.name, links: Array.isArray(t.links) ? t.links : [] }));
    this.order = this._reconcileOrder(raw.order);
    this.assignments = raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {};
    this.sessionOrder = raw.sessionOrder && typeof raw.sessionOrder === 'object' ? raw.sessionOrder : {};
    // Keep only todos under a still-valid bucket (a real task id or ADHOC) so an
    // orphaned task's todos can't linger after the task is gone.
    const validBuckets = new Set([...this.tasks.map((t) => t.id), ADHOC]);
    this.todos = {};
    if (raw.todos && typeof raw.todos === 'object') {
      for (const [bucket, list] of Object.entries(raw.todos)) {
        if (validBuckets.has(bucket) && Array.isArray(list)) this.todos[bucket] = list;
      }
    }
  }

  _save() {
    writeJsonAtomic(this.file, {
      tasks: this.tasks,
      order: this.order,
      assignments: this.assignments,
      sessionOrder: this.sessionOrder,
      todos: this.todos,
    });
  }

  snapshot() {
    return {
      tasks: this.tasks.map((t) => ({ ...t })),
      order: [...this.order],
      assignments: { ...this.assignments },
      sessionOrder: Object.fromEntries(Object.entries(this.sessionOrder).map(([k, v]) => [k, [...v]])),
      todos: Object.fromEntries(Object.entries(this.todos).map(([k, v]) => [k, v.map((td) => ({ ...td }))])),
    };
  }

  // Append a session to its task's order list (idempotent); call after the
  // assignment lands. Drops it from any other task's list first so the
  // sessionOrder lists stay a partition mirroring `assignments`.
  _orderAppend(sessionId, taskId) {
    for (const tid of Object.keys(this.sessionOrder)) {
      if (tid === taskId) continue;
      this.sessionOrder[tid] = this.sessionOrder[tid].filter((s) => s !== sessionId);
    }
    if (!taskId) return;
    const list = this.sessionOrder[taskId] || (this.sessionOrder[taskId] = []);
    if (!list.includes(sessionId)) list.push(sessionId);
  }

  _orderRemove(sessionId) {
    for (const tid of Object.keys(this.sessionOrder)) {
      this.sessionOrder[tid] = this.sessionOrder[tid].filter((s) => s !== sessionId);
    }
  }

  createTask({ name = 'New task', sessionId } = {}) {
    if (this.tasks.length >= MAX_TASKS) throw new Error(`Task limit reached (max ${MAX_TASKS}).`);
    const task = { id: `t_${crypto.randomBytes(4).toString('hex')}`, name: (name || 'New task').trim() || 'New task', links: [] };
    this.tasks.push(task);
    this.order.push(task.id); // new tasks land at the very end (after Ad hoc)
    if (sessionId) {
      this.assignments[sessionId] = task.id;
      this._orderAppend(sessionId, task.id);
    }
    this._save();
    return task;
  }

  renameTask(id, name) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return false;
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed === task.name) return false;
    task.name = trimmed;
    this._save();
    return true;
  }

  assign(sessionId, taskId) {
    if (!sessionId) return false;
    if (!taskId) {
      delete this.assignments[sessionId];
      this._orderRemove(sessionId);
    } else if (this.tasks.some((t) => t.id === taskId)) {
      this.assignments[sessionId] = taskId;
      this._orderAppend(sessionId, taskId);
    } else return false;
    this._save();
    return true;
  }

  // The task a session is currently assigned to, as {id, name}, or null. Used at
  // archive time to snapshot the task name so History can still show it after the
  // task is later deleted (which drops the assignment).
  taskFor(sessionId) {
    const id = this.assignments[sessionId];
    const task = id && this.tasks.find((t) => t.id === id);
    return task ? { id: task.id, name: task.name } : null;
  }

  getLinks(taskId) {
    const task = this.tasks.find((t) => t.id === taskId);
    return task ? [...(task.links || [])] : [];
  }

  // Replace a task's whole link list (the MCP set_links contract). Caller has
  // already validated/normalised each link. Returns false for an unknown id.
  setLinks(taskId, links) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    task.links = Array.isArray(links) ? [...links] : [];
    this._save();
    return true;
  }

  // Every pr link across all tasks, as
  // { ownerId, url, number, checkStatus, dirty } — the poll loop's input.
  // number/checkStatus/dirty drive the check-transition and dirty-transition
  // notifiers; the update path only reads url, so the wider payload is backward-safe.
  prLinks() {
    const out = [];
    for (const t of this.tasks)
      for (const l of t.links || [])
        if (l.type === 'pr' && l.url)
          out.push({ ownerId: t.id, url: l.url, number: l.number, checkStatus: l.checkStatus, dirty: l.dirty });
    return out;
  }

  // Write checkStatus/dirty/checkStatusFetchedAt onto the pr link with this url,
  // in place (so a concurrent setLinks replacing the list is last-writer-wins but
  // the poller never resurrects a removed link). Always bumps the freshness
  // timestamp on a match, but returns true only when checkStatus OR dirty actually
  // changed (false if both unchanged or not found) — that return drives the
  // poller's rebuild, so a stable PR mustn't trigger a graph broadcast.
  updateLinkStatus(taskId, url, checkStatus, dirty, fetchedAt) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const link = (task.links || []).find((l) => l.type === 'pr' && l.url === url);
    if (!link) return false;
    const changed = link.checkStatus !== checkStatus || Boolean(link.dirty) !== Boolean(dirty);
    link.checkStatus = checkStatus;
    link.dirty = dirty;
    link.checkStatusFetchedAt = fetchedAt;
    this._save();
    return changed;
  }

  unassign(sessionId) {
    if (this.assignments[sessionId] === undefined) return false;
    delete this.assignments[sessionId];
    this._orderRemove(sessionId);
    this._save();
    return true;
  }

  // Move a session to the end of its current bucket's stored order. Waking a
  // snoozed session drops the sink-to-bottom effect that held it below its
  // active siblings — without this, it reappears at whatever rank it held
  // before falling asleep (often near the front, if it's an older session),
  // which reads as the card jumping to the top on click. A no-op if the
  // bucket has no explicit order yet, or the session isn't in it.
  bumpToEnd(sessionId) {
    const bucket = this.assignments[sessionId] || ADHOC;
    const list = this.sessionOrder[bucket];
    if (!list) return false;
    const i = list.indexOf(sessionId);
    if (i === -1) return false;
    list.splice(i, 1);
    list.push(sessionId);
    this._save();
    return true;
  }

  // A todo bucket is a real task id or the ADHOC sentinel — never an arbitrary id,
  // so a stale client can't write todos into a non-existent task.
  _isBucket(id) {
    return id === ADHOC || this.tasks.some((t) => t.id === id);
  }

  // Append a TODO to its bucket. Blank text is a no-op (returns null); an unknown
  // bucket is rejected. createdAt is injectable for deterministic tests. The id is
  // a fresh handle — a TODO carries no link to any session, so this is its only key.
  // null taskId maps to ADHOC (the handlers coerce the unassigned tile's key to null).
  addTodo(taskId, text, createdAt = Date.now()) {
    const bucket = taskId || ADHOC;
    const trimmed = (text || '').trim();
    if (!trimmed || !this._isBucket(bucket)) return null;
    const todo = { id: `td_${crypto.randomBytes(4).toString('hex')}`, text: trimmed, createdAt };
    (this.todos[bucket] || (this.todos[bucket] = [])).push(todo);
    this._save();
    return todo;
  }

  // Inline rename. No-op on blank, unchanged, or an unknown bucket/todo.
  // null taskId maps to ADHOC.
  editTodo(taskId, todoId, text) {
    const bucket = taskId || ADHOC;
    const trimmed = (text || '').trim();
    const todo = (this.todos[bucket] || []).find((td) => td.id === todoId);
    if (!todo || !trimmed || trimmed === todo.text) return false;
    todo.text = trimmed;
    this._save();
    return true;
  }

  // Remove a TODO. Consumed and deleted are the same end-state.
  // Keeps the map sparse: deletes the key when the list empties.
  // null taskId maps to ADHOC.
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

  // Reassign a TODO across buckets (drag-and-drop). Keeps the map sparse.
  // No-op for same bucket, unknown todo, or unknown target.
  // null taskIds map to ADHOC.
  moveTodo(todoId, fromTaskId, toTaskId) {
    const from = fromTaskId || ADHOC, to = toTaskId || ADHOC;
    if (from === to || !this._isBucket(to)) return false;
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

  // Delete a task, returning a restore snapshot ({task, index, assignments,
  // order, todos}) so the deletion can be reverted exactly, or null if unknown.
  // Delete is fully reversible: nothing is killed, sessions just fall back to Ad hoc.
  deleteTask(id) {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index < 0) return null;
    const [task] = this.tasks.splice(index, 1);
    const orderIndex = this.order.indexOf(id);
    this.order = this.order.filter((x) => x !== id);
    const assignments = {};
    for (const [sid, tid] of Object.entries(this.assignments))
      if (tid === id) {
        assignments[sid] = tid;
        delete this.assignments[sid];
      }
    const order = this.sessionOrder[id] || [];
    delete this.sessionOrder[id];
    // Don't destroy the task's TODOs — fall them back onto Ad-hoc, exactly as the
    // freed sessions unassign there, so delete stays fully reversible.
    const todos = this.todos[id] || [];
    delete this.todos[id];
    if (todos.length) (this.todos[ADHOC] || (this.todos[ADHOC] = [])).push(...todos);
    this._save();
    return { task: { ...task }, index, orderIndex, assignments, order: [...order], todos: todos.map((td) => ({ ...td })) };
  }

  // Revert a deleteTask: re-insert the task at its original position (in both
  // `tasks` and `order`) and restore its assignments and session order. No-op if
  // the id is already present.
  restoreTask(snap) {
    if (!snap || this.tasks.some((t) => t.id === snap.task.id)) return false;
    this.tasks.splice(Math.min(snap.index, this.tasks.length), 0, { ...snap.task });
    const oi = snap.orderIndex ?? this.order.length;
    this.order.splice(Math.min(oi, this.order.length), 0, snap.task.id);
    Object.assign(this.assignments, snap.assignments);
    this.sessionOrder[snap.task.id] = [...snap.order];
    // Pull the task's TODOs back out of Ad-hoc (where deleteTask parked them) and
    // reinstate them on the recovered task — the inverse of the delete fallback.
    const restoredIds = new Set((snap.todos || []).map((td) => td.id));
    if (this.todos[ADHOC]) {
      this.todos[ADHOC] = this.todos[ADHOC].filter((td) => !restoredIds.has(td.id));
      if (!this.todos[ADHOC].length) delete this.todos[ADHOC];
    }
    if (snap.todos && snap.todos.length) this.todos[snap.task.id] = snap.todos.map((td) => ({ ...td }));
    this._save();
    return true;
  }

  // Drag-and-drop reorder over the combined `order` (tasks + the ADHOC sentinel):
  // dropping `id` onto `targetId` SWAPS their two positions. Swap (not insert)
  // because the tiles are column-packed in 2-D — exchanging two tiles keeps the
  // columns balanced and matches the gesture, whereas a linear insert would pull
  // a tile across columns and unbalance them. `id`/`targetId` may be the ADHOC
  // sentinel. Returns false on no-op / unknown.
  reorderTask(id, targetId) {
    if (!targetId || id === targetId) return false;
    const i = this.order.indexOf(id);
    const j = this.order.indexOf(targetId);
    if (i < 0 || j < 0) return false;
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    this._save();
    return true;
  }

  // Set the session order of a bucket (a real task id, or the ADHOC sentinel for
  // the unassigned tile) to the client-supplied `order`, stored verbatim. We take
  // the whole order rather than a single move because the client already computes
  // it from the rendered cell, and — unlike a real task — Ad-hoc members never
  // pass through assign(), so the server can't be relied on to pre-hold a complete
  // list to move within. `order` is filtered to the bucket's current partition
  // (sessions assigned to `bucket`, or unassigned for ADHOC) so a stale client
  // can't strand a session in the wrong list. Returns false on no-op / unknown.
  reorderSession(bucket, order) {
    if (!bucket || !Array.isArray(order)) return false;
    const belongs = bucket === ADHOC ? (s) => !this.assignments[s] : (s) => this.assignments[s] === bucket;
    const next = [...new Set(order.filter((s) => typeof s === 'string' && belongs(s)))];
    const list = this.sessionOrder[bucket] || [];
    if (next.length === list.length && next.every((s, i) => s === list[i])) return false;
    this.sessionOrder[bucket] = next;
    this._save();
    return true;
  }
}
