import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoAddHandler, todoEditHandler, todoDeleteHandler, todoMoveHandler, todoReorderHandler, todoHandlers } from './handlers.js';
import { fakeHost } from './test-helpers.js';

const texts = (store, bucket) => (store.snapshot().todos[bucket] || []).map((x) => x.text);

test('handler types keep their wire names', () => {
  assert.deepEqual(todoHandlers.map((h) => h.type), ['todo-add', 'todo-edit', 'todo-delete', 'todo-move', 'todo-reorder']);
});

test('todo-add writes to a task or (missing taskId) adhoc, and rebuilds', async () => {
  const { host, store, calls } = fakeHost();
  await todoAddHandler.handler({ type: 'todo-add', text: 'ship' }, host);
  await todoAddHandler.handler({ type: 'todo-add', taskId: 't1', text: 'ship it' }, host);
  assert.deepEqual(texts(store, 'adhoc'), ['ship']);
  assert.deepEqual(texts(store, 't1'), ['ship it']);
  assert.equal(calls.rebuild, 2);
});

test('todo-add into an unknown task is rejected but still rebuilds', async () => {
  const { host, store, calls } = fakeHost();
  await todoAddHandler.handler({ type: 'todo-add', taskId: 't_gone', text: 'x' }, host);
  assert.deepEqual(store.snapshot().todos, {});
  assert.equal(calls.rebuild, 1);
});

test('todo-add and todo-edit pass descriptions; malformed ones are ignored', async () => {
  const { host, store } = fakeHost();
  await todoAddHandler.handler({ type: 'todo-add', text: 'Investigate', description: 'Found a race.' }, host);
  await todoAddHandler.handler({ type: 'todo-add', text: 'Plain', description: 7 }, host);
  const [first, plain] = store.snapshot().todos.adhoc;
  assert.equal(first.description, 'Found a race.');
  assert.equal(plain.description, undefined);
  await todoEditHandler.handler({ type: 'todo-edit', todoId: first.id, description: 'Next: test.' }, host);
  await todoEditHandler.handler({ type: 'todo-edit', todoId: first.id, text: 'Renamed', description: null }, host);
  const edited = store.snapshot().todos.adhoc[0];
  assert.deepEqual({ text: edited.text, description: edited.description }, { text: 'Renamed', description: 'Next: test.' });
});

test('todo-delete, todo-move and todo-reorder mutate and rebuild', async () => {
  const { host, store, calls } = fakeHost();
  const a = store.addTodo('t1', 'a', 1);
  const b = store.addTodo('t1', 'b', 2);
  await todoReorderHandler.handler({ type: 'todo-reorder', taskId: 't1', order: [b.id, a.id] }, host);
  assert.deepEqual(texts(store, 't1'), ['b', 'a']);
  await todoMoveHandler.handler({ type: 'todo-move', todoId: a.id, fromTaskId: 't1' }, host);
  assert.deepEqual(texts(store, 'adhoc'), ['a']);
  await todoDeleteHandler.handler({ type: 'todo-delete', taskId: 't1', todoId: b.id }, host);
  assert.deepEqual(store.snapshot().todos.t1, undefined);
  assert.equal(calls.rebuild, 3);
});

test('todo-move to an unknown task is a no-op; non-array order is tolerated', async () => {
  const { host, store, calls } = fakeHost();
  const a = store.addTodo('t1', 'a', 1);
  await todoMoveHandler.handler({ type: 'todo-move', todoId: a.id, fromTaskId: 't1', toTaskId: 't_gone' }, host);
  await todoReorderHandler.handler({ type: 'todo-reorder', taskId: 't1', order: 'x' }, host);
  assert.deepEqual(texts(store, 't1'), ['a']);
  assert.equal(calls.rebuild, 2);
});
