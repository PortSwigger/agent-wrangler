import { z } from 'zod';

// Patch one item on THIS session's checklist. Granular (one item per call), not
// a whole-list replace: the human can edit the same list from the board at any
// moment, and a replace-call would let a stale read silently clobber an edit
// made seconds earlier. Caller-resolved target, same as add_checklist_item.
export const updateChecklistItemTool = {
  name: 'update_checklist_item',
  description:
    'Update one item on your own session\'s checklist — tick it off (`done: true`) or reword '
    + 'it (`text`). Pass whichever you mean; an omitted field is left alone. Mark an item done '
    + 'when the work it names is actually finished, so the human can see progress on the board. '
    + 'This list is independent of your own internal planning tool and is never synced with it. '
    + 'It writes to the session you are running in — there is no session parameter. Get item ids '
    + 'from list_checklist.',
  inputSchema: {
    id: z.string().min(1).describe('The item id, from list_checklist or add_checklist_item.'),
    text: z.string().min(1).optional().describe('New text for the item. Omit to leave it unchanged.'),
    done: z.boolean().optional().describe('Whether the item is complete. Omit to leave it unchanged.'),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so there is no checklist to update.');
    if (args.text === undefined && args.done === undefined) {
      return errorResult('Nothing to update — pass `text`, `done`, or both.');
    }
    // Absent-vs-present matters here (a `{done:false}` patch is a real change,
    // and `{text: undefined}` must not blank the item), so build the patch from
    // exactly the keys that were supplied.
    const patch = {};
    if (args.text !== undefined) patch.text = args.text;
    if (args.done !== undefined) patch.done = args.done;
    let changed;
    try {
      changed = deps.checklistStore.update(caller, args.id, patch);
    } catch (err) {
      return errorResult(String(err.message || err));
    }
    if (!changed) {
      // Deliberately not an error: the id may be right and the values already
      // what was asked for, which is the state the caller wanted.
      const exists = deps.checklistStore.list(caller).some((it) => it.id === args.id);
      if (!exists) return errorResult(`No checklist item with id ${args.id} on this session.`);
    }
    if (changed) await deps.rebuild?.();
    const structuredContent = { id: args.id, changed };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
