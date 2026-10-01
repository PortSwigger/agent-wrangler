import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../data-dir.js';

export const LEGACY_TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

// One-shot import of the TODOs core used to keep under `todos` in tasks.json.
// Runs at activation. Idempotent: a todos.json already marked `migrated` is
// never re-imported. tasks.json is only ever READ (never backed up or renamed,
// even when corrupt: that is TaskStore's business); core keeps the raw `todos`
// value there as an opaque pass-through, so a failed migration is retried next
// boot and a downgrade still finds them. Orphan buckets are not filtered here
// (no task list); the graph's first-call prune handles them.
// Returns 'skipped' | 'imported' | 'none' | 'failed'.
export function migrateFromTasks(store, { tasksFile = LEGACY_TASKS_FILE, log = () => {} } = {}) {
  if (store.migrated) return 'skipped';
  let raw = null;
  try {
    let text = null;
    try { text = fs.readFileSync(tasksFile, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (text && text.trim()) raw = JSON.parse(text);
  } catch (err) {
    log(`[todos] could not read legacy todos from ${tasksFile}: ${err.message}; will retry next boot`);
    return 'failed';
  }
  const legacy = raw?.todos;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return 'none';
  try {
    store.replaceAll(legacy);
  } catch (err) {
    log(`[todos] could not write todos.json: ${err.message}; will retry next boot`);
    store.todos = {};
    store.migrated = false;
    return 'failed';
  }
  return 'imported';
}
