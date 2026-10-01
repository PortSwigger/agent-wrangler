import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import todos, { dir } from './index.js';
import { validateManifest, RESERVED_GRAPH_KEYS, BUILTIN, loadExtensions } from '../../index.js';
import { fakeHost } from './test-helpers.js';

test('the manifest validates and is registered as a builtin living in its own directory', () => {
  assert.doesNotThrow(() => validateManifest({ ...todos, dir }));
  assert.ok(BUILTIN.includes(todos));
  assert.deepEqual(dir.split(path.sep).slice(-2), ['builtin', 'todos']);
  assert.equal(todos.defaultEnabled, true);
});

test('it loads enabled, unquarantined, declaring its skill, tools and handlers', () => {
  const loaded = loadExtensions({ cfg: {}, builtin: [{ ...todos, dir }] });
  const row = loaded.list.find((e) => e.id === 'todos');
  assert.ok(row.enabled);
  assert.ok(!row.quarantine);
  assert.deepEqual(loaded.tools.map((t) => t.name).sort(), ['add_todo', 'delete_todo', 'edit_todo', 'list_todos', 'move_todo', 'reorder_todos']);
  assert.equal(loaded.taskDeleteHooks.length, 1);
});

test('shipped client assets and the skill exist on disk', () => {
  assert.ok(fs.existsSync(path.join(dir, 'public', 'client.js')));
  assert.ok(fs.existsSync(path.join(dir, 'public', 'styles.css')));
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'archive-to-todo', 'SKILL.md')));
});

test('the graph key is "todos" and is not reserved', () => {
  assert.equal(RESERVED_GRAPH_KEYS.has('todos'), false);
  const { host, store } = fakeHost();
  store.addTodo('t1', 'a', 1);
  const out = todos.graph({ host, graph: {} });
  assert.deepEqual(Object.keys(out), ['todos']);
  assert.deepEqual(out.todos.t1.map((t) => t.text), ['a']);
});

test('the first graph call prunes orphan buckets once; later calls do not re-read tasks', () => {
  const { host, store } = fakeHost();
  store.addTodo('t1', 'keep', 1);
  store.addTodo('t_gone', 'orphan', 2);
  store.addTodo(null, 'adhoc', 3);
  let listed = 0;
  const list = host.tasks.list;
  host.tasks.list = () => { listed += 1; return list(); };
  const out = todos.graph({ host, graph: {} });
  assert.deepEqual(Object.keys(out.todos).sort(), ['adhoc', 't1']);
  todos.graph({ host, graph: {} });
  assert.equal(listed, 1);
  assert.equal(store.snapshot().todos.t_gone, undefined);
});

test('onTaskDelete drops that task\'s bucket', () => {
  const { host, store } = fakeHost();
  store.addTodo('t1', 'a', 1);
  store.addTodo('t2', 'b', 2);
  todos.onTaskDelete({ taskId: 't1', host });
  assert.deepEqual(Object.keys(store.snapshot().todos), ['t2']);
});
