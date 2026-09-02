// TODO mutators: mutate the store, then rebuild. A missing taskId means the
// Unassigned tile — coerced to null, and addTodo/editTodo/deleteTodo map null → ADHOC
// via _isBucket (addTodo) or the null key (edit/delete). moveTodo gets both ends coerced.
// No memory binding — a TODO has no session/memory link.
export const todoAddHandler = {
  type: 'todo-add',
  async handler(msg, ctx) {
    ctx.taskStore.addTodo(msg.taskId || null, msg.text);
    await ctx.rebuild();
  },
};

export const todoEditHandler = {
  type: 'todo-edit',
  async handler(msg, ctx) {
    ctx.taskStore.editTodo(msg.taskId || null, msg.todoId, msg.text);
    await ctx.rebuild();
  },
};

export const todoDeleteHandler = {
  type: 'todo-delete',
  async handler(msg, ctx) {
    ctx.taskStore.deleteTodo(msg.taskId || null, msg.todoId);
    await ctx.rebuild();
  },
};

export const todoMoveHandler = {
  type: 'todo-move',
  async handler(msg, ctx) {
    ctx.taskStore.moveTodo(msg.todoId, msg.fromTaskId || null, msg.toTaskId || null);
    await ctx.rebuild();
  },
};

export const todoReorderHandler = {
  type: 'todo-reorder',
  async handler(msg, ctx) {
    ctx.taskStore.reorderTodos(msg.taskId || null, Array.isArray(msg.order) ? msg.order : []);
    await ctx.rebuild();
  },
};
