import { z } from 'zod';

function result(structuredContent) {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

function error(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// The bucket key for a task id, or null when the task is unknown or archived.
function bucket(host, taskId) {
  const id = taskId || null;
  if (id && id !== host.tasks.adhocId) {
    const task = host.tasks.get(id);
    if (!task || task.archived) return null;
  }
  return id || host.tasks.adhocId;
}

function todos(host, taskId) {
  return host.stores.todos.snapshot().todos[taskId || host.tasks.adhocId] || [];
}

const taskId = z.string().min(1).nullable().optional().describe('Task id from list_tasks. Omit or pass null for Unassigned.');
const todoId = z.string().min(1).describe('TODO id returned by list_todos or add_todo.');

export const listTodosTool = {
  name: 'list_todos',
  description: 'List board TODOs for one task, in display order. Pass a task id from list_tasks, or omit task_id for Unassigned. These task TODOs are separate from session checklists.',
  inputSchema: { task_id: taskId },
  async handler({ host }, args = {}) {
    if (!bucket(host, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    return result({ task_id: args.task_id || null, todos: todos(host, args.task_id) });
  },
};

export const addTodoTool = {
  name: 'add_todo',
  description: 'Add a board TODO to a task from list_tasks, or to Unassigned when task_id is omitted. An optional description can capture findings, remaining work, and a useful next step from an exploratory session. Returns the new TODO id. Board TODOs are separate from session checklists.',
  inputSchema: { task_id: taskId, text: z.string().min(1).describe('Short TODO title.'), description: z.string().optional().describe('Optional free-form handoff details; Markdown is fine. Consider findings, remaining work, and the next step.') },
  async handler({ host }, args = {}) {
    if (!bucket(host, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (!args.text?.trim()) return error('TODO text cannot be empty.');
    const todo = host.stores.todos.addTodo(args.task_id || null, args.text, Date.now(), args.description);
    if (!todo) return error('Could not add TODO.');
    await host.rebuild();
    return result({ id: todo.id, task_id: args.task_id || null });
  },
};

export const editTodoTool = {
  name: 'edit_todo',
  description: 'Change a board TODO title or description. Supply either field or both; an empty description clears it. Use its id from list_todos and the task_id of its current task; omit task_id for Unassigned.',
  inputSchema: { task_id: taskId, id: todoId, text: z.string().min(1).optional().describe('New TODO title; omit to keep the current title.'), description: z.string().optional().describe('New free-form description; omit to keep it, or pass an empty string to clear it.') },
  async handler({ host }, args = {}) {
    if (!bucket(host, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (args.text === undefined && args.description === undefined) return error('Supply text or description to edit.');
    if (args.text !== undefined && !args.text.trim()) return error('TODO text cannot be empty.');
    const current = todos(host, args.task_id).find((todo) => todo.id === args.id);
    if (!current) return error(`Unknown TODO ${args.id} in this task — check list_todos.`);
    const changed = host.stores.todos.editTodo(args.task_id || null, args.id, args.text, args.description);
    if (changed) await host.rebuild();
    return result({ changed });
  },
};

export const deleteTodoTool = {
  name: 'delete_todo',
  description: 'Delete a board TODO after it is done or no longer needed. Use its id from list_todos and its task_id; omit task_id for Unassigned.',
  inputSchema: { task_id: taskId, id: todoId },
  async handler({ host }, args = {}) {
    if (!bucket(host, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (!host.stores.todos.deleteTodo(args.task_id || null, args.id)) return error(`Unknown TODO ${args.id} in this task — check list_todos.`);
    await host.rebuild();
    return result({ deleted: true });
  },
};

export const moveTodoTool = {
  name: 'move_todo',
  description: 'Move a board TODO between tasks or Unassigned. Supply its id and current from_task_id; omit either task id for Unassigned. The TODO is appended to the destination.',
  inputSchema: { id: todoId, from_task_id: taskId, to_task_id: taskId },
  async handler({ host }, args = {}) {
    if (!bucket(host, args.from_task_id)) return error(`Unknown source task ${args.from_task_id} — check list_tasks.`);
    if (!bucket(host, args.to_task_id)) return error(`Unknown destination task ${args.to_task_id} — check list_tasks.`);
    if (!todos(host, args.from_task_id).some((todo) => todo.id === args.id)) return error(`Unknown TODO ${args.id} in the source task — check list_todos.`);
    const moved = host.stores.todos.moveTodo(args.id, args.from_task_id || null, args.to_task_id || null);
    if (moved) await host.rebuild();
    return result({ moved });
  },
};

export const reorderTodosTool = {
  name: 'reorder_todos',
  description: 'Reorder board TODOs within a task or Unassigned. Give TODO ids in the desired order; any omitted TODOs stay at the end in their existing order.',
  inputSchema: { task_id: taskId, order: z.array(z.string()).describe('TODO ids in desired order, from list_todos.') },
  async handler({ host }, args = {}) {
    if (!bucket(host, args.task_id)) return error(`Unknown task ${args.task_id} — check list_tasks for valid ids.`);
    if (!Array.isArray(args.order)) return error('order must be an array of TODO ids.');
    const changed = host.stores.todos.reorderTodos(args.task_id || null, args.order);
    if (changed) await host.rebuild();
    return result({ changed });
  },
};

export const todoTools = [listTodosTool, addTodoTool, editTodoTool, deleteTodoTool, moveTodoTool, reorderTodosTool];
