import { z } from 'zod';

// Give any board session (including the caller) a custom display title — the
// session-to-session counterpart to the board's Rename action (server/control/
// handlers/rename.js). A title is deliberately durable: state-reader.js's
// sessionLabel gives an explicit user-chosen name priority over the live title
// and auto-derived intent/summary, so an agent can turn an unwieldy launch
// prompt into a concise board-card label. Passing an empty name deliberately
// clears that override and returns the card to its current derived label.
//
// Unlike the board handler, this rejects an id unknown to the registry before
// calling sessionManager.rename. The board has a graph snapshot and uses its
// rename path to self-heal externally discovered sessions; an MCP caller with a
// mistyped id is much more likely to want a loud error than an inert new mapping.
export const renameSessionTool = {
  name: 'rename_session',
  description:
    'Set a custom board-card title for any Agent Wrangler session, including yourself — the '
    + 'session-to-session counterpart to the board\'s Rename action. Get the target id from '
    + 'list_sessions. Pass an empty name to clear the custom title and return to the auto-derived '
    + 'label. A set title wins over the live/derived label until cleared, per state-reader.js\'s '
    + 'sessionLabel behavior.',
  inputSchema: {
    target: z.string().min(1).describe('Session id (card id) to rename, as returned by list_sessions.'),
    name: z.string().describe('New custom title. An empty string clears it and restores the derived label.'),
  },
  async handler({ deps }, args = {}) {
    const target = (args.target ?? '').trim();
    if (!target) return errorResult('target is required.');
    const entry = deps.sessionManager.entryFor(target);
    if (!entry) return errorResult(`Unknown session ${target} — no such session on the board.`);
    const name = args.name ?? '';
    deps.sessionManager.rename(target, name, { cwd: entry.cwd, intent: entry.intent });
    await deps.rebuild?.();
    const structuredContent = { target, name: name.trim() || null, renamed: true };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
