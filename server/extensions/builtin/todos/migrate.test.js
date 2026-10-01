import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TodoStore } from './store.js';
import { migrateFromTasks } from './migrate.js';
import { createTodoStore } from './index.js';
import { tmpDir } from './test-helpers.js';

const legacy = { t1: [{ id: 'td_1', text: 'one', createdAt: 1 }], adhoc: [{ id: 'td_2', text: 'two', description: 'd', createdAt: 2 }], bad: 'x' };

function setup(tasks) {
  const dir = tmpDir();
  const tasksFile = path.join(dir, 'tasks.json');
  const file = path.join(dir, 'todos.json');
  if (tasks !== undefined) fs.writeFileSync(tasksFile, typeof tasks === 'string' ? tasks : JSON.stringify(tasks));
  return { dir, tasksFile, file };
}

test('imports todos from tasks.json, marks migrated, leaves tasks.json untouched', () => {
  const { tasksFile, file } = setup({ tasks: [], todos: legacy });
  const before = fs.readFileSync(tasksFile, 'utf8');
  const store = new TodoStore(file);
  assert.equal(migrateFromTasks(store, { tasksFile }), 'imported');
  assert.deepEqual(Object.keys(store.snapshot().todos).sort(), ['adhoc', 't1']);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.migrated, true);
  assert.equal(onDisk.todos.adhoc[0].description, 'd');
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
});

test('is idempotent: a marked todos.json is never re-imported, so edits and deletions stick', () => {
  const { tasksFile, file } = setup({ todos: legacy });
  const first = createTodoStore({}, { file, tasksFile });
  first.deleteTodo('t1', 'td_1');
  first.deleteTodo(null, 'td_2');
  const second = createTodoStore({}, { file, tasksFile });
  assert.equal(migrateFromTasks(second, { tasksFile }), 'skipped');
  assert.deepEqual(second.snapshot().todos, {});
});

test('does not duplicate on repeated activation', () => {
  const { tasksFile, file } = setup({ todos: legacy });
  createTodoStore({}, { file, tasksFile });
  createTodoStore({}, { file, tasksFile });
  assert.equal(createTodoStore({}, { file, tasksFile }).snapshot().todos.t1.length, 1);
});

test('absent tasks.json writes nothing and starts empty', () => {
  const { tasksFile, file } = setup();
  const store = new TodoStore(file);
  assert.equal(migrateFromTasks(store, { tasksFile }), 'none');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(store.snapshot().todos, {});
  store.addTodo(null, 'first');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).migrated, true);
});

test('tasks.json without todos writes nothing', () => {
  const { tasksFile, file } = setup({ tasks: [] });
  assert.equal(migrateFromTasks(new TodoStore(file), { tasksFile }), 'none');
  assert.equal(fs.existsSync(file), false);
});

test('a corrupt tasks.json fails soft: logged, untouched, todos.json unmarked, retried next boot', () => {
  const { dir, tasksFile, file } = setup('{not json');
  const logs = [];
  const store = new TodoStore(file);
  assert.equal(migrateFromTasks(store, { tasksFile, log: (m) => logs.push(m) }), 'failed');
  assert.equal(logs.length, 1);
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), '{not json');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['tasks.json']);
  fs.writeFileSync(tasksFile, JSON.stringify({ todos: legacy }));
  assert.equal(migrateFromTasks(new TodoStore(file), { tasksFile }), 'imported');
});

test('a failed write leaves todos.json unmarked and the store empty so the next boot retries', () => {
  const { dir, tasksFile } = setup({ todos: legacy });
  // todos.json path whose parent is a regular file: the write must fail.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const file = path.join(blocker, 'todos.json');
  const logs = [];
  const store = new TodoStore(file);
  assert.equal(migrateFromTasks(store, { tasksFile, log: (m) => logs.push(m) }), 'failed');
  assert.equal(store.migrated, false);
  assert.deepEqual(store.snapshot().todos, {});
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(tasksFile, 'utf8')).todos, legacy);
});
