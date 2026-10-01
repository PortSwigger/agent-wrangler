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
//     sessionOrder: {taskId | 'adhoc': [sessionId, …]} }
// The 'adhoc' sessionOrder key (when present) belongs to the unassigned tile.
//
// Board TODOs used to live here as `todos`; the builtin todos extension owns
// them now (todos.json). DECISION: the raw `todos` value read from the file is
// kept as an opaque pass-through (`_legacyTodos`) and written back unchanged,
// never read or mutated. A downgrade within a release still finds them, and a
// migration that failed (the extension retries every boot until todos.json is
// marked migrated) still has its source. Remove once that window has passed.
export class TaskStore {
  constructor(file = TASKS_FILE) {
    this.file = file;
    this.tasks = [];
    this.order = [ADHOC];
    this.assignments = {};
    this.sessionOrder = {};
    this._legacyTodos = undefined;
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
    this.tasks = tasks.map((t) => ({
      id: t.id,
      name: t.name,
      links: Array.isArray(t.links) ? t.links : [],
      ...(t.archivedAt ? { archivedAt: t.archivedAt } : {}),
    }));
    this.order = this._reconcileOrder(raw.order);
    this.assignments = raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {};
    this.sessionOrder = raw.sessionOrder && typeof raw.sessionOrder === 'object' ? raw.sessionOrder : {};
    if (raw.todos !== undefined) this._legacyTodos = raw.todos;
  }

  _save() {
    writeJsonAtomic(this.file, {
      tasks: this.tasks,
      order: this.order,
      assignments: this.assignments,
      sessionOrder: this.sessionOrder,
      ...(this._legacyTodos !== undefined ? { todos: this._legacyTodos } : {}),
    });
  }

  snapshot() {
    return {
      tasks: this.tasks.map((t) => ({ ...t })),
      order: [...this.order],
      assignments: { ...this.assignments },
      sessionOrder: Object.fromEntries(Object.entries(this.sessionOrder).map(([k, v]) => [k, [...v]])),
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
    // Archived tasks stay in `this.tasks` forever (see archiveTask) so they must
    // not count against the cap, or archiving old tasks can never free up room.
    if (this.tasks.filter((t) => !t.archivedAt).length >= MAX_TASKS) throw new Error(`Task limit reached (max ${MAX_TASKS}).`);
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
    } else if (this.tasks.some((t) => t.id === taskId && !t.archivedAt)) {
      this.assignments[sessionId] = taskId;
      this._orderAppend(sessionId, taskId);
    } else return false;
    this._save();
    return true;
  }

  // The task a session is currently assigned to, as {id, name}, or null. Used at
  // archive time to snapshot the task name onto the session entry, so Search can
  // still match the archived session by the name the task had back then, even
  // after a later rename.
  taskFor(sessionId) {
    const id = this.assignments[sessionId];
    const task = id && this.tasks.find((t) => t.id === id);
    return task ? { id: task.id, name: task.name } : null;
  }

  // Whether sessionId is currently assigned to a task that is itself archived —
  // the resume-time check that decides whether resuming this session ALONE
  // (without its task) should fall back to Ad-hoc rather than leave a stale
  // assignment that would resurrect it under the task's tile if that task is
  // restored later. False for an unassigned session or a live task.
  isAssignedToArchivedTask(sessionId) {
    const id = this.assignments[sessionId];
    const task = id && this.tasks.find((t) => t.id === id);
    return Boolean(task?.archivedAt);
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
  // { ownerId, url, number, checkStatus, headSha, dirty, unresolvedCount } — the
  // poll loop's input. The wider payload drives transition notifiers while the
  // update path still reads only url.
  prLinks() {
    const out = [];
    for (const t of this.tasks)
      for (const l of t.links || [])
        if (l.type === 'pr' && l.url)
          out.push({ ownerId: t.id, url: l.url, number: l.number, checkStatus: l.checkStatus, headSha: l.headSha, dirty: l.dirty, unresolvedCount: l.unresolvedCount });
    return out;
  }

  // Write checkStatus/headSha/dirty/checkStatusFetchedAt/unresolvedCount onto the
  // matching PR link in place (so a concurrent setLinks replacing the list
  // is last-writer-wins but the poller never resurrects a removed link).
  // Always bumps the freshness timestamp on a match, but returns true only
  // when checkStatus OR dirty actually changed (false if both unchanged or not
  // found) — that return drives the poller's rebuild, so a stable PR mustn't
  // trigger a graph broadcast. headSha/unresolvedCount are deliberately EXCLUDED
  // from that comparison: they render nowhere in public/, so poll-only changes
  // shouldn't force a graph rebuild — the unresolved-comment notifier reads the
  // persisted value straight from the store on every sweep regardless of this
  // return. Poll-only
  // fields are appended after fetchedAt so existing positional-arg call sites
  // aren't shifted.
  updateLinkStatus(taskId, url, checkStatus, dirty, fetchedAt, unresolvedCount, headSha) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const link = (task.links || []).find((l) => l.type === 'pr' && l.url === url);
    if (!link) return false;
    const changed = link.checkStatus !== checkStatus || Boolean(link.dirty) !== Boolean(dirty);
    link.checkStatus = checkStatus;
    link.dirty = dirty;
    link.checkStatusFetchedAt = fetchedAt;
    link.unresolvedCount = unresolvedCount;
    if (typeof headSha === 'string' && headSha) link.headSha = headSha;
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

  // Remove a task outright: its entry, its slot in `order`, its session order, and
  // every assignment pointing at it (those sessions fall back to Ad hoc). Returns
  // the ids of the sessions it unassigned, or null for an unknown id. Everything
  // else keyed by task id lives OUTSIDE this store (task memory, extension
  // data), so the caller announces the deletion to extensions afterwards
  // (control/handlers/tasks.js -> onTaskDelete) rather than this reaching for them.
  deleteTask(id) {
    const at = this.tasks.findIndex((t) => t.id === id);
    if (at < 0) return null;
    this.tasks.splice(at, 1);
    this.order = this.order.filter((x) => x !== id);
    delete this.sessionOrder[id];
    const unassigned = Object.entries(this.assignments).filter(([, tid]) => tid === id).map(([sid]) => sid);
    for (const sid of unassigned) delete this.assignments[sid];
    this._save();
    return unassigned;
  }

  // Archive a task in place: stamp archivedAt so the live board (currentOrder in
  // app.js) filters it out. Everything else (assignments,
  // sessionOrder, links, its slot in `order`) stays untouched, so
  // unarchiveTask is an exact, instant revert with no snapshot bookkeeping.
  // No-op (false) for an unknown or already-archived id.
  archiveTask(id, archivedAt = Date.now()) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.archivedAt) return false;
    task.archivedAt = archivedAt;
    this._save();
    return true;
  }

  // Revert archiveTask. No-op (false) for an unknown or not-currently-archived id.
  unarchiveTask(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || !task.archivedAt) return false;
    delete task.archivedAt;
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
