import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todoAddHandler, todoEditHandler, todoDeleteHandler, todoMoveHandler, todoReorderHandler } from './todos.js';

function ctx() {
  const calls = { addTodo: [], editTodo: [], deleteTodo: [], moveTodo: [], reorderTodos: [], rebuild: 0 };
  return {
    calls,
    taskStore: {
      addTodo: (taskId, text) => calls.addTodo.push({ taskId, text }),
      editTodo: (taskId, todoId, text) => calls.editTodo.push({ taskId, todoId, text }),
      deleteTodo: (taskId, todoId) => calls.deleteTodo.push({ taskId, todoId }),
      moveTodo: (todoId, fromTaskId, toTaskId) => calls.moveTodo.push({ todoId, fromTaskId, toTaskId }),
      reorderTodos: (taskId, order) => calls.reorderTodos.push({ taskId, order }),
    },
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('todo-add calls addTodo and rebuilds; coerces missing taskId to null', async () => {
  const c = ctx();
  await todoAddHandler.handler({ type: 'todo-add', text: 'ship' }, c);
  assert.deepEqual(c.calls.addTodo, [{ taskId: null, text: 'ship' }]);
  assert.equal(c.calls.rebuild, 1);
});

test('todo-add passes a real taskId through', async () => {
  const c = ctx();
  await todoAddHandler.handler({ type: 'todo-add', taskId: 'T1', text: 'ship' }, c);
  assert.deepEqual(c.calls.addTodo, [{ taskId: 'T1', text: 'ship' }]);
});

test('todo-edit calls editTodo and rebuilds; coerces missing taskId to null', async () => {
  const c = ctx();
  await todoEditHandler.handler({ type: 'todo-edit', todoId: 'td_1', text: 'new' }, c);
  assert.deepEqual(c.calls.editTodo, [{ taskId: null, todoId: 'td_1', text: 'new' }]);
  assert.equal(c.calls.rebuild, 1);
});

test('todo-delete calls deleteTodo and rebuilds; coerces missing taskId to null', async () => {
  const c = ctx();
  await todoDeleteHandler.handler({ type: 'todo-delete', todoId: 'td_1' }, c);
  assert.deepEqual(c.calls.deleteTodo, [{ taskId: null, todoId: 'td_1' }]);
  assert.equal(c.calls.rebuild, 1);
});

test('todo-move passes todoId/from/to and rebuilds; coerces missing to null', async () => {
  const c = ctx();
  await todoMoveHandler.handler({ type: 'todo-move', todoId: 'td_1', toTaskId: 'T2' }, c);
  assert.deepEqual(c.calls.moveTodo, [{ todoId: 'td_1', fromTaskId: null, toTaskId: 'T2' }]);
  assert.equal(c.calls.rebuild, 1);
});

test('todo-reorder passes taskId/order and rebuilds; coerces missing taskId to null', async () => {
  const c = ctx();
  await todoReorderHandler.handler({ type: 'todo-reorder', order: ['td_2', 'td_1'] }, c);
  assert.deepEqual(c.calls.reorderTodos, [{ taskId: null, order: ['td_2', 'td_1'] }]);
  assert.equal(c.calls.rebuild, 1);
});

test('todo-reorder passes a real taskId through; defaults a missing order to []', async () => {
  const c = ctx();
  await todoReorderHandler.handler({ type: 'todo-reorder', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.reorderTodos, [{ taskId: 'T1', order: [] }]);
});
