import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, linkPathFor, addDirFor } from './memory-store.js';
import { getMemoryHandler, setMemoryHandler } from './handlers.js';

// Task memory: one freeform markdown file per task, shared by the human and the
// agents working under that task. The first builtin extension — everything that
// used to be core (the store and its watcher, the AW_TASK_MEMORY env and the
// --add-dir grant on every launch, the skill, the modal and menu items) lives
// here, and turning the extension off removes all of it.
//
// A LEAF module (index.test.js asserts it): it reaches the server only through
// the `host` façade it is handed. Its store is built by the loader's store
// factory, so it exists exactly while the extension is active.

export const dir = path.dirname(fileURLToPath(import.meta.url));

// One watcher per store instance, so deactivate can stop the one activate began.
const watchers = new WeakMap();

// session.launchContext: bind the session to its task's folder BEFORE the launch
// command is built, then hand the launch the env var and the one directory grant.
// Claude gets the stable per-session symlink (it re-resolves it on every access,
// so a later reassignment is followed without a relaunch); Codex 0.149+ rejects a
// symlinked writable root, so it gets the resolved real target instead and picks
// a reassignment up on its next relaunch.
export function launchContext({ sid, task, agent, host }) {
  const store = host.stores.taskMemory;
  const binding = store.bindSession(sid, task?.id || null);
  if (!binding) return {}; // an unsafe session id: nothing to bind
  const codex = agent === 'codex';
  return {
    env: { AW_TASK_MEMORY: codex ? binding.memoryPath : linkPathFor(sid) },
    addDirs: [codex ? binding.memoryDir : addDirFor(sid)],
  };
}

// The tile's "has memory" dot, without shipping the content in the graph.
export function graph({ host, graph: g }) {
  const store = host.stores.taskMemory;
  for (const t of g?.tasks?.tasks || []) t.hasMemory = store.hasMemory(t.id);
  return {};
}

export function activate({ host }) {
  const store = host.stores.taskMemory;
  // Memory changing on disk (an agent's append or the human's own editor):
  // refresh the dot via a rebuild and nudge any open editor to live-refresh.
  const watcher = store.createWatcher();
  watcher.on('change', (taskId) => {
    host.rebuild().catch(() => {});
    host.broadcast({ kind: 'changed', taskId });
  });
  watchers.set(store, watcher);
  // The archive review's output lands in the task's memory.md. Subscribed here
  // rather than called from the runner, so with this extension off the review's
  // result has nowhere to go (and the runner does not spend a model call on it).
  host.events.on('archive-review:completed', ({ taskId, markdown }) => {
    if (taskId && typeof markdown === 'string') store.append(taskId, markdown);
  });
}

export function deactivate({ host }) {
  const store = host?.stores?.taskMemory;
  if (!store) return;
  watchers.get(store)?.close();
  watchers.delete(store);
}

export default {
  id: 'task-memory',
  label: 'Task memory',
  help: 'Shared per-task notes agents are asked to read at session start. Off hides the memory button and stops instructing agents to read the file; existing notes are kept on disk.',
  description: 'A shared markdown note per task that you and the agents on it edit together.',
  author: 'Agent Wrangler',
  defaultEnabled: true,
  dir,
  requires: ['board:rebuild', 'board:broadcast', 'events'],
  stores: { taskMemory: () => new MemoryStore() },
  handlers: [getMemoryHandler, setMemoryHandler],
  skills: ['task-memory'],
  hooks: { 'session.launchContext': launchContext },
  // A permanently removed session drops its by-session link and scratch folder.
  session: {
    onPurge: ({ sessionId, host }) => { host.stores.taskMemory.forget(sessionId); },
  },
  // A deleted task drops its memory file and any session links pointing at it.
  onTaskDelete: ({ taskId, host }) => { host.stores.taskMemory.deleteTask(taskId); },
  graph,
  activate,
  deactivate,
  client: 'public/index.js',
  styles: 'public/styles.css',
};
