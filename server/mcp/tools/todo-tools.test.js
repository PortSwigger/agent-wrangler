import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../../task-store.js';
import { todoTools } from './todo-tools.js';
import { TOOLS } from './index.js';
import { allowedToolName, allowedToolsArg } from '../client-config.js';

const byName = Object.fromEntries(todoTools.map((tool) => [tool.name, tool]));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mcp-todo-'));
  const taskStore = new TaskStore(path.join(dir, 'tasks.json'));
  const task = taskStore.createTask({ name: 'Project' });
  let rebuilds = 0;
  const deps = { taskStore, rebuild: async () => { rebuilds++; } };
  return { deps, task, rebuilds: () => rebuilds };
}

async function call(name, deps, args) {
  return byName[name].handler({ deps }, args);
}

test('TODO tools are registered and granted to launched sessions', () => {
  const granted = allowedToolsArg({ checklist: false, ext: { allowedToolNames: [] } }).split(',');
  for (const tool of todoTools) {
    assert.ok(TOOLS.some((registered) => registered.name === tool.name), tool.name);
    assert.ok(granted.includes(allowedToolName(tool.name)), tool.name);
  }
});

test('list_todos reads task and Unassigned buckets in stored order', async () => {
  const { deps, task } = setup();
  deps.taskStore.addTodo(task.id, 'first', 1);
  deps.taskStore.addTodo(task.id, 'second', 2);
  deps.taskStore.addTodo(null, 'loose', 3);
  const taskResult = await call('list_todos', deps, { task_id: task.id });
  assert.deepEqual(taskResult.structuredContent.todos.map((todo) => todo.text), ['first', 'second']);
  const adhocResult = await call('list_todos', deps, {});
  assert.deepEqual(adhocResult.structuredContent.todos.map((todo) => todo.text), ['loose']);
  assert.equal(adhocResult.structuredContent.task_id, null);
  assert.equal((await call('list_todos', deps, { task_id: 't_missing' })).isError, true);
});

test('add_todo validates the bucket and text, returns an id, and rebuilds only after a change', async () => {
  const { deps, task, rebuilds } = setup();
  const added = await call('add_todo', deps, { task_id: task.id, text: '  write tests  ' });
  assert.match(added.structuredContent.id, /^td_/);
  assert.deepEqual(deps.taskStore.snapshot().todos[task.id].map((todo) => todo.text), ['write tests']);
  assert.equal(rebuilds(), 1);
  assert.equal((await call('add_todo', deps, { task_id: 't_missing', text: 'x' })).isError, true);
  assert.equal((await call('add_todo', deps, { text: '   ' })).isError, true);
  assert.equal(rebuilds(), 1);
});

test('edit_todo and delete_todo target the specified bucket', async () => {
  const { deps, task, rebuilds } = setup();
  const todo = deps.taskStore.addTodo(task.id, 'old');
  assert.equal((await call('edit_todo', deps, { task_id: task.id, id: todo.id, text: 'new' })).structuredContent.changed, true);
  assert.equal(deps.taskStore.snapshot().todos[task.id][0].text, 'new');
  assert.equal((await call('edit_todo', deps, { id: todo.id, text: 'wrong bucket' })).isError, true);
  assert.equal((await call('edit_todo', deps, { task_id: task.id, id: todo.id, text: '  ' })).isError, true);
  assert.equal((await call('delete_todo', deps, { id: todo.id })).isError, true);
  assert.equal((await call('delete_todo', deps, { task_id: task.id, id: todo.id })).structuredContent.deleted, true);
  assert.equal(deps.taskStore.snapshot().todos[task.id], undefined);
  assert.equal(rebuilds(), 2);
});

test('move_todo and reorder_todos preserve task store semantics', async () => {
  const { deps, task, rebuilds } = setup();
  const first = deps.taskStore.addTodo(task.id, 'first');
  const second = deps.taskStore.addTodo(task.id, 'second');
  const third = deps.taskStore.addTodo(task.id, 'third');
  assert.equal((await call('reorder_todos', deps, { task_id: task.id, order: [third.id, first.id] })).structuredContent.changed, true);
  assert.deepEqual(deps.taskStore.snapshot().todos[task.id].map((todo) => todo.id), [third.id, first.id, second.id]);
  assert.equal((await call('move_todo', deps, { id: first.id, from_task_id: task.id })).structuredContent.moved, true);
  assert.deepEqual(deps.taskStore.snapshot().todos.adhoc.map((todo) => todo.id), [first.id]);
  assert.equal((await call('move_todo', deps, { id: first.id, from_task_id: task.id, to_task_id: task.id })).isError, true);
  assert.equal((await call('reorder_todos', deps, { task_id: 't_missing', order: [] })).isError, true);
  assert.equal(rebuilds(), 2);
});
