import { z } from 'zod';

function result(structuredContent) {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function error(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function bucket(deps, taskId) {
  const id = taskId || null;
  if (id && !deps.taskStore.snapshot().tasks.some((task) => task.id === id)) return null;
  return id || 'adhoc';
}

function todos(deps, taskId) {
  return deps.taskStore.snapshot().todos[taskId || 'adhoc'] || [];
}

const taskId = z.string().min(1).nullable().optional().describe('Task id from list_tasks. Omit or pass null for Unassigned.');
const todoId = z.string().min(1).describe('TODO id returned by list_todos or add_todo.');

export const listTodosTool = {
  name: 'list_todos',
  description: 'List board TODOs for one task, in display order. Pass a task id from list_tasks, or omit task_id for Unassigned. These task TODOs are separate from session checklists.',
  inputSchema: { task_id: taskId },
  async handler({ deps }, args = {}) {
    if (!bucket(deps, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    return result({ task_id: args.task_id || null, todos: todos(deps, args.task_id) });
  },
};

export const addTodoTool = {
  name: 'add_todo',
  description: 'Add a board TODO to a task from list_tasks, or to Unassigned when task_id is omitted. Returns the new TODO id. Board TODOs are separate from session checklists.',
  inputSchema: { task_id: taskId, text: z.string().min(1).describe('TODO text.') },
  async handler({ deps }, args = {}) {
    if (!bucket(deps, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (!args.text?.trim()) return error('TODO text cannot be empty.');
    const todo = deps.taskStore.addTodo(args.task_id || null, args.text);
    if (!todo) return error('Could not add TODO.');
    await deps.rebuild?.();
    return result({ id: todo.id, task_id: args.task_id || null });
  },
};

export const editTodoTool = {
  name: 'edit_todo',
  description: 'Change the text of a board TODO. Use its id from list_todos and the task_id of its current task; omit task_id for Unassigned.',
  inputSchema: { task_id: taskId, id: todoId, text: z.string().min(1).describe('New TODO text.') },
  async handler({ deps }, args = {}) {
    if (!bucket(deps, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (!args.text?.trim()) return error('TODO text cannot be empty.');
    const current = todos(deps, args.task_id).find((todo) => todo.id === args.id);
    if (!current) return error(`Unknown TODO ${args.id} in this task — check list_todos.`);
    const changed = deps.taskStore.editTodo(args.task_id || null, args.id, args.text);
    if (changed) await deps.rebuild?.();
    return result({ changed });
  },
};

export const deleteTodoTool = {
  name: 'delete_todo',
  description: 'Delete a board TODO after it is done or no longer needed. Use its id from list_todos and its task_id; omit task_id for Unassigned.',
  inputSchema: { task_id: taskId, id: todoId },
  async handler({ deps }, args = {}) {
    if (!bucket(deps, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (!deps.taskStore.deleteTodo(args.task_id || null, args.id)) return error(`Unknown TODO ${args.id} in this task — check list_todos.`);
    await deps.rebuild?.();
    return result({ deleted: true });
  },
};

export const moveTodoTool = {
  name: 'move_todo',
  description: 'Move a board TODO between tasks or Unassigned. Supply its id and current from_task_id; omit either task id for Unassigned. The TODO is appended to the destination.',
  inputSchema: { id: todoId, from_task_id: taskId, to_task_id: taskId },
  async handler({ deps }, args = {}) {
    if (!bucket(deps, args.from_task_id)) return error(`Unknown source task ${args.from_task_id} — check list_tasks.`);
    if (!bucket(deps, args.to_task_id)) return error(`Unknown destination task ${args.to_task_id} — check list_tasks.`);
    if (!todos(deps, args.from_task_id).some((todo) => todo.id === args.id)) return error(`Unknown TODO ${args.id} in the source task — check list_todos.`);
    const moved = deps.taskStore.moveTodo(args.id, args.from_task_id || null, args.to_task_id || null);
    if (moved) await deps.rebuild?.();
    return result({ moved });
  },
};

export const reorderTodosTool = {
  name: 'reorder_todos',
  description: 'Reorder board TODOs within a task or Unassigned. Give TODO ids in the desired order; any omitted TODOs stay at the end in their existing order.',
  inputSchema: { task_id: taskId, order: z.array(z.string()).describe('TODO ids in desired order, from list_todos.') },
  async handler({ deps }, args = {}) {
    if (!bucket(deps, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (!Array.isArray(args.order)) return error('order must be an array of TODO ids.');
    const changed = deps.taskStore.reorderTodos(args.task_id || null, args.order);
    if (changed) await deps.rebuild?.();
    return result({ changed });
  },
};

export const todoTools = [listTodosTool, addTodoTool, editTodoTool, deleteTodoTool, moveTodoTool, reorderTodosTool];
