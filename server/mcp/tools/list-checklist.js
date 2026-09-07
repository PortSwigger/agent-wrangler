// Read THIS session's own checklist. Read-only, caller-resolved — there is no
// session parameter, so it can never surface a sibling session's list.
export const listChecklistTool = {
  name: 'list_checklist',
  description:
    'List your own session\'s checklist, in display order, as {id, text, done, createdAt}. Read '
    + 'it before updating so you have the item ids, and to see anything the HUMAN added or '
    + 'reworded from the board — they edit the same list you do, so it can change without you. '
    + 'This is independent of your own internal planning tool and is never synced with it. It '
    + 'reads the session you are running in — there is no session parameter, and you cannot '
    + 'list another session\'s checklist.',
  inputSchema: {},
  async handler({ deps, caller }) {
    if (caller == null) return errorResult('This request carried no session identity, so there is no checklist to list.');
    const structuredContent = { items: deps.checklistStore.list(caller) };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
