import { z } from 'zod';

// Drop one item from THIS session's checklist. Caller-resolved target, same as
// the other three — a session can only ever touch its own list.
export const removeChecklistItemTool = {
  name: 'remove_checklist_item',
  description:
    'Remove one item from your own session\'s checklist. Use it for an item that turned out to '
    + 'be unnecessary or wrong — a finished item should be marked done with update_checklist_item '
    + 'instead, so the human can see it was completed rather than silently vanishing. This list '
    + 'is independent of your own internal planning tool. It writes to the session you are '
    + 'running in — there is no session parameter.',
  inputSchema: {
    id: z.string().min(1).describe('The item id, from list_checklist.'),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so there is no checklist to remove from.');
    const removed = deps.checklistStore.remove(caller, args.id);
    if (!removed) return errorResult(`No checklist item with id ${args.id} on this session.`);
    await deps.rebuild?.();
    const structuredContent = { id: args.id, removed: true };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
