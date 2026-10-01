// Board TODO mutators: validate the bucket, mutate the store, then rebuild. A
// missing taskId means the Unassigned tile (coerced to null; the store maps
// null to 'adhoc'). A bucket is valid when it is the ad hoc id or a task that
// exists (archived tasks keep their TODOs), so a stale client can't write into a
// task that is gone. No memory binding: a TODO has no session/memory link.
const description = (msg) => (typeof msg.description === 'string' ? msg.description : undefined);

function validBucket(host, taskId) {
  return !taskId || taskId === host.tasks.adhocId || Boolean(host.tasks.get(taskId));
}

export const todoAddHandler = {
  type: 'todo-add',
  async handler(msg, host) {
    if (validBucket(host, msg.taskId)) host.stores.todos.addTodo(msg.taskId || null, msg.text, Date.now(), description(msg));
    await host.rebuild();
  },
};

export const todoEditHandler = {
  type: 'todo-edit',
  async handler(msg, host) {
    host.stores.todos.editTodo(msg.taskId || null, msg.todoId, msg.text, description(msg));
    await host.rebuild();
  },
};

export const todoDeleteHandler = {
  type: 'todo-delete',
  async handler(msg, host) {
    host.stores.todos.deleteTodo(msg.taskId || null, msg.todoId);
    await host.rebuild();
  },
};

export const todoMoveHandler = {
  type: 'todo-move',
  async handler(msg, host) {
    if (validBucket(host, msg.toTaskId)) host.stores.todos.moveTodo(msg.todoId, msg.fromTaskId || null, msg.toTaskId || null);
    await host.rebuild();
  },
};

export const todoReorderHandler = {
  type: 'todo-reorder',
  async handler(msg, host) {
    host.stores.todos.reorderTodos(msg.taskId || null, Array.isArray(msg.order) ? msg.order : []);
    await host.rebuild();
  },
};

export const todoHandlers = [todoAddHandler, todoEditHandler, todoDeleteHandler, todoMoveHandler, todoReorderHandler];
