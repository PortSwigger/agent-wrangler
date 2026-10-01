import { z } from 'zod';

// Append one item to THIS session's visible checklist — the list the human sees
// on the board card's panel. The target session is the caller's own card id
// (extractCaller), never an argument: a `session` parameter would let a launched
// agent write into a sibling's checklist by hallucinating an id or lifting one
// off list_sessions.
export const addChecklistItemTool = {
  name: 'add_checklist_item',
  description:
    'Add one item to your own session\'s checklist — a short, durable list of what you are '
    + 'working through that the human can see on the board without reading your terminal. '
    + 'This is NOT your own internal planning tool and is never synced with it: keep the '
    + 'blow-by-blow of individual tool calls in your private plan, and put here only the '
    + 'few human-relevant steps someone glancing at the board would want to know about. '
    + 'It writes to the session you are running in — there is no session parameter, and you '
    + 'cannot reach another session\'s checklist. See the `checklist` skill for when an item '
    + 'is worth adding.',
  inputSchema: {
    text: z.string().min(1).describe('The item, as a short imperative phrase (e.g. "Migrate the auth middleware"). One step per call.'),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so there is no checklist to add to.');
    let item;
    try {
      item = deps.checklistStore.add(caller, args.text);
    } catch (err) {
      return errorResult(String(err.message || err));
    }
    if (!item) return errorResult('Checklist item text cannot be empty.');
    await deps.rebuild?.();
    const structuredContent = { id: item.id };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
