// Per-session checklist mutators — the human half of a list the launched agent
// also writes through its own MCP tools. Mirrors the todos extension handlers: mutate the store,
// then rebuild so every open board re-renders. Keyed on the CARD ID
// (msg.sessionId), never liveSessionId. No memory binding — a checklist item has
// no session-launch side effect.
//
// The store's mutators are synchronous and its cap breaches throw, so a
// rejected add surfaces through the router's error envelope as a toast rather
// than being swallowed here.
export const checklistAddHandler = {
  type: 'checklist-add',
  async handler(msg, host) {
    host.stores.checklist.add(msg.sessionId, msg.text);
    await host.rebuild();
  },
};

export const checklistUpdateHandler = {
  type: 'checklist-update',
  async handler(msg, host) {
    // Only the fields actually present are patched, so a checkbox toggle can't
    // blank the text and an inline rename can't reset `done`.
    const patch = {};
    if (msg.text !== undefined) patch.text = msg.text;
    if (msg.done !== undefined) patch.done = msg.done;
    host.stores.checklist.update(msg.sessionId, msg.itemId, patch);
    await host.rebuild();
  },
};

export const checklistRemoveHandler = {
  type: 'checklist-remove',
  async handler(msg, host) {
    host.stores.checklist.remove(msg.sessionId, msg.itemId);
    await host.rebuild();
  },
};

export const checklistReorderHandler = {
  type: 'checklist-reorder',
  async handler(msg, host) {
    host.stores.checklist.reorder(msg.sessionId, Array.isArray(msg.order) ? msg.order : []);
    await host.rebuild();
  },
};
