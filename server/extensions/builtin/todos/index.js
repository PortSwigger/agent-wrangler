import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TodoStore, TODOS_FILE } from './store.js';
import { migrateFromTasks, LEGACY_TASKS_FILE } from './migrate.js';
import { todoHandlers } from './handlers.js';
import { todoTools } from './tools.js';

export const dir = path.dirname(fileURLToPath(import.meta.url));

// Store factory. `paths` is the test seam for the two files; the loader passes
// only the bag. Migration runs here, at activation, before anything reads.
export function createTodoStore(bag = {}, paths = {}) {
  const store = new TodoStore(paths.file ?? TODOS_FILE);
  migrateFromTasks(store, { tasksFile: paths.tasksFile ?? LEGACY_TASKS_FILE, log: bag.log ?? (() => {}) });
  return store;
}

// Drops buckets whose task no longer exists. Once per store, on the first graph
// call (the loader makes one at activation with a real host); cheap after that.
function pruneOnce(store, host) {
  if (store._pruned) return;
  store._pruned = true;
  try {
    const valid = new Set([host.tasks.adhocId, ...host.tasks.list().map((t) => t.taskId)]);
    store.prune(valid);
  } catch {
    store._pruned = false; // retry next tick
  }
}

export default {
  id: 'todos',
  dir,
  label: 'TODOs',
  help: 'Per-task board TODOs: un-started work you can park on a task and turn into a session later.',
  description: 'Board TODOs for each task and the Unassigned tile, with MCP tools for agents and the archive-to-todo handoff skill.',
  defaultEnabled: true,
  engines: { wranglerApi: '^1.15.0' },
  requires: ['tasks:read', 'board:rebuild'],
  stores: { todos: createTodoStore },
  handlers: todoHandlers,
  tools: todoTools,
  graph({ host }) {
    const store = host.stores.todos;
    pruneOnce(store, host);
    return { todos: store.snapshot().todos };
  },
  onTaskDelete({ taskId, host }) {
    host.stores.todos.dropBucket(taskId);
  },
  skills: ['archive-to-todo'],
  client: 'public/client.js',
  styles: 'public/styles.css',
};
