import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TodoStore } from './store.js';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-todos-'));
}

// A façade double: real TodoStore, a fixed task list, and a rebuild counter.
export function fakeHost({ tasks = [{ taskId: 't1', name: 'One', archived: false }], file } = {}) {
  const store = new TodoStore(file ?? path.join(tmpDir(), 'todos.json'));
  const calls = { rebuild: 0 };
  const host = {
    stores: { todos: store },
    tasks: {
      adhocId: 'adhoc',
      list: () => tasks,
      get: (id) => tasks.find((t) => t.taskId === id) ?? null,
    },
    rebuild: async () => { calls.rebuild += 1; },
  };
  return { host, store, calls };
}
