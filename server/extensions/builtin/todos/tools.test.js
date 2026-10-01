import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoTools } from './tools.js';
import { fakeHost } from './test-helpers.js';
import { allowedToolName, allowedToolsArg } from '../../../mcp/client-config.js';
import { TOOLS } from '../../../mcp/tools/index.js';
import { BUILTIN, loadExtensions } from '../../index.js';

const byName = Object.fromEntries(todoTools.map((tool) => [tool.name, tool]));

function setup() {
  const live = { taskId: 't1', name: 'Project', archived: false };
  const tasks = [live];
  const ctx = fakeHost({ tasks });
  return { ...ctx, task: live, tasks };
}

const call = (name, host, args) => byName[name].handler({ host, caller: 'CARD' }, args);

test('the six TODO tools keep their names and are granted via the loader, not the core list', () => {
  assert.deepEqual(todoTools.map((t) => t.name), ['list_todos', 'add_todo', 'edit_todo', 'delete_todo', 'move_todo', 'reorder_todos']);
  assert.equal(TOOLS.some((t) => byName[t.name]), false);
  const ext = loadExtensions({ cfg: {}, builtin: BUILTIN });
  const granted = allowedToolsArg({ checklist: false, ext }).split(',');
  for (const tool of todoTools) assert.ok(granted.includes(allowedToolName(tool.name)), tool.name);
  assert.equal(allowedToolsArg({ checklist: false, ext: { allowedToolNames: [] } }).includes('list_todos'), false);
});

test('list_todos reads task and Unassigned buckets in stored order', async () => {
  const { host, store, task } = setup();
  store.addTodo(task.taskId, 'first', 1);
  store.addTodo(task.taskId, 'second', 2);
  store.addTodo(null, 'loose', 3);
  const taskResult = await call('list_todos', host, { task_id: task.taskId });
  assert.deepEqual(taskResult.structuredContent.todos.map((todo) => todo.text), ['first', 'second']);
  const adhocResult = await call('list_todos', host, {});
  assert.deepEqual(adhocResult.structuredContent.todos.map((todo) => todo.text), ['loose']);
  assert.equal(adhocResult.structuredContent.task_id, null);
  assert.equal((await call('list_todos', host, { task_id: 't_missing' })).isError, true);
});

test('add_todo validates the bucket and text, returns an id, and rebuilds only after a change', async () => {
  const { host, store, task, calls } = setup();
  const added = await call('add_todo', host, { task_id: task.taskId, text: '  write tests  ' });
  assert.match(added.structuredContent.id, /^td_/);
  assert.deepEqual(store.snapshot().todos[task.taskId].map((todo) => todo.text), ['write tests']);
  assert.equal(calls.rebuild, 1);
  assert.equal((await call('add_todo', host, { task_id: 't_missing', text: 'x' })).isError, true);
  assert.equal((await call('add_todo', host, { text: '   ' })).isError, true);
  assert.equal(calls.rebuild, 1);
});

test('MCP creates, lists, updates, and clears a TODO description independently of its title', async () => {
  const { host, store, task } = setup();
  const created = await call('add_todo', host, { task_id: task.taskId, text: 'Investigate', description: 'Found a race.' });
  const id = created.structuredContent.id;
  assert.equal((await call('list_todos', host, { task_id: task.taskId })).structuredContent.todos[0].description, 'Found a race.');
  assert.equal((await call('edit_todo', host, { task_id: task.taskId, id, description: 'Next: add test.' })).structuredContent.changed, true);
  assert.equal(store.snapshot().todos[task.taskId][0].text, 'Investigate');
  assert.equal((await call('edit_todo', host, { task_id: task.taskId, id, description: '' })).structuredContent.changed, true);
  assert.equal(store.snapshot().todos[task.taskId][0].description, undefined);
  assert.equal((await call('edit_todo', host, { task_id: task.taskId, id })).isError, true);
});

test('edit_todo and delete_todo target the specified bucket', async () => {
  const { host, store, task, calls } = setup();
  const todo = store.addTodo(task.taskId, 'old');
  assert.equal((await call('edit_todo', host, { task_id: task.taskId, id: todo.id, text: 'new' })).structuredContent.changed, true);
  assert.equal(store.snapshot().todos[task.taskId][0].text, 'new');
  assert.equal((await call('edit_todo', host, { id: todo.id, text: 'wrong bucket' })).isError, true);
  assert.equal((await call('edit_todo', host, { task_id: task.taskId, id: todo.id, text: '  ' })).isError, true);
  assert.equal((await call('delete_todo', host, { id: todo.id })).isError, true);
  assert.equal((await call('delete_todo', host, { task_id: task.taskId, id: todo.id })).structuredContent.deleted, true);
  assert.equal(store.snapshot().todos[task.taskId], undefined);
  assert.equal(calls.rebuild, 2);
});

test('move_todo and reorder_todos preserve store semantics', async () => {
  const { host, store, task, calls } = setup();
  const first = store.addTodo(task.taskId, 'first');
  const second = store.addTodo(task.taskId, 'second');
  const third = store.addTodo(task.taskId, 'third');
  assert.equal((await call('reorder_todos', host, { task_id: task.taskId, order: [third.id, first.id] })).structuredContent.changed, true);
  assert.deepEqual(store.snapshot().todos[task.taskId].map((todo) => todo.id), [third.id, first.id, second.id]);
  assert.equal((await call('move_todo', host, { id: first.id, from_task_id: task.taskId })).structuredContent.moved, true);
  assert.deepEqual(store.snapshot().todos.adhoc.map((todo) => todo.id), [first.id]);
  assert.equal((await call('move_todo', host, { id: first.id, from_task_id: task.taskId, to_task_id: task.taskId })).isError, true);
  assert.equal((await call('reorder_todos', host, { task_id: 't_missing', order: [] })).isError, true);
  assert.equal(calls.rebuild, 2);
});

test('archived task TODOs cannot be read or changed through MCP', async () => {
  const { host, store, task, calls } = setup();
  const todo = store.addTodo(task.taskId, 'hidden soon');
  const loose = store.addTodo(null, 'visible');
  host.tasks.get = () => ({ ...task, archived: true });
  assert.equal((await call('list_todos', host, { task_id: task.taskId })).isError, true);
  assert.equal((await call('add_todo', host, { task_id: task.taskId, text: 'hidden' })).isError, true);
  assert.equal((await call('edit_todo', host, { task_id: task.taskId, id: todo.id, text: 'changed' })).isError, true);
  assert.equal((await call('delete_todo', host, { task_id: task.taskId, id: todo.id })).isError, true);
  assert.equal((await call('move_todo', host, { id: loose.id, to_task_id: task.taskId })).isError, true);
  assert.equal((await call('reorder_todos', host, { task_id: task.taskId, order: [todo.id] })).isError, true);
  assert.equal(calls.rebuild, 0);
  assert.deepEqual(store.snapshot().todos[task.taskId].map((item) => item.text), ['hidden soon']);
});

test('same-bucket move reports no change without rebuilding', async () => {
  const { host, store, task, calls } = setup();
  const todo = store.addTodo(task.taskId, 'stay');
  const out = await call('move_todo', host, { id: todo.id, from_task_id: task.taskId, to_task_id: task.taskId });
  assert.deepEqual(out.structuredContent, { moved: false });
  assert.equal(calls.rebuild, 0);
});
