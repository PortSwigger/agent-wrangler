import { formatMailMeta } from '../../mail-format.js';

// Metadata-only view of your own mailbox — no bodies, ever (even a small one).
// Serves "what did that worker tell me?" after a compaction: find the id here,
// then fetch that one message in full with read_mail({id}). No search tool —
// the box is capped by construction (20 unread / 100 retained read), so this
// list is always small.
export const listMailTool = {
  name: 'list_mail',
  description:
    'List every message in your own mailbox (unread, read, and undeliverable), oldest-first, '
    + 'as metadata only — id, sender, timestamp, size, read state, and a short excerpt. Never '
    + 'includes a full body, even for a small message. Use it to find a message\'s id, then '
    + 'read_mail({id}) to fetch it in full. Each entry carries both `from` (a raw session id) and '
    + '`fromLabel` (that session\'s name) — prefer `fromLabel` when telling the user who a message '
    + 'is from, but labels aren\'t guaranteed unique (see the `session-hierarchy` skill), so if '
    + 'more than one sender is in view pair the label with a short id.',
  inputSchema: {},
  async handler({ deps, caller }) {
    if (caller == null) return errorResult('This request carried no session identity, so there is no mailbox to list.');
    const structuredContent = { messages: deps.mailStore.list(caller).map(formatMailMeta) };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
