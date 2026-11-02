import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../data-dir.js';
import { writeJsonAtomic } from '../../../atomic-json.js';

export const LEGACY_TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

// One-shot move of the TODOs core used to keep under `todos` in tasks.json.
// The import runs at activation, which is BEFORE the instance lock, so it only
// reads tasks.json. Idempotent: a todos.json already marked `migrated` is never
// re-imported. Once todos.json is written and marked, the `todos` key is queued
// for removal from tasks.json (`store.legacyStrip`); the extension's sweep
// performs it via stripLegacyTodos, which only runs after the lock, so a
// duplicate instance that is about to be refused never rewrites the live
// owner's tasks.json. TaskStore drops its in-memory copy on its next save. A
// failed import leaves the key in place and is retried next boot. Orphan
// buckets are not filtered here (no task list); the graph's first-call prune
// handles them.
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
  store.legacyStrip = { tasksFile, log };
  return 'imported';
}

// Removes the legacy `todos` key from tasks.json. Re-reads the file so it
// builds on the current contents, and leaves a missing, unparseable or
// todos-less file alone (a corrupt file is TaskStore's business).
export function stripLegacyTodos({ tasksFile, log = () => {} }) {
  try {
    const raw = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    if (!raw || typeof raw !== 'object' || !('todos' in raw)) return false;
    delete raw.todos;
    writeJsonAtomic(tasksFile, raw);
    return true;
  } catch (err) {
    log(`[todos] imported legacy todos but could not remove them from ${tasksFile}: ${err.message}`);
    return false;
  }
}
