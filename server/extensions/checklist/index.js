import { fileURLToPath } from 'node:url';
import { ChecklistStore } from './store.js';
import {
  checklistAddHandler, checklistUpdateHandler, checklistRemoveHandler, checklistReorderHandler,
} from './handlers.js';
import { addChecklistItemTool } from './tools/add-checklist-item.js';
import { updateChecklistItemTool } from './tools/update-checklist-item.js';
import { removeChecklistItemTool } from './tools/remove-checklist-item.js';
import { listChecklistTool } from './tools/list-checklist.js';

// The per-session checklist, as an extension manifest (server/extensions/index.js).
// Everything the feature needs to be gated as ONE unit lives here: its store, its
// four control-WS handlers, its four MCP tools (the launch --allowedTools grant is
// derived from them by the loader), its skill, its graph contribution and its
// one session hook. Lifecycle is by construction: resume keeps the list (no hook),
// a fork starts EMPTY (no onFork — do not add one), archive keeps it (no
// onArchive), only a purge forgets (onPurge). `dir` is what the loader resolves a
// `client` path against; the client module itself lands in a later PR.
export const dir = fileURLToPath(new URL('.', import.meta.url));

export default {
  id: 'checklist',
  label: 'Per-session checklist',
  help: 'A short list of what a session is working through, shown beside its terminal and editable by you and the agent (which gets four MCP tools for it). Turning it off hides the panel straight away and stops instructing agents to keep one — stored checklists are kept, so turning it back on restores them. The four MCP tools are baked into the launch command, so an already-running session only gains or loses them at its next resume. Turning it back on restores the panel immediately unless it was already off when the wrangler started, in which case it needs a restart.',
  defaultEnabled: true,
  dir,
  stores: { checklist: () => new ChecklistStore() },
  handlers: [checklistAddHandler, checklistUpdateHandler, checklistRemoveHandler, checklistReorderHandler],
  tools: [addChecklistItemTool, updateChecklistItemTool, removeChecklistItemTool, listChecklistTool],
  skills: ['checklist'],
  // Session-scoped, but carried as a whole-store snapshot rather than per-card
  // enrichment: the only consumer is the ONE selected session's panel.
  graph: ({ stores }) => ({ checklists: stores.checklist.snapshot() }),
  session: { onPurge: ({ sessionId, stores }) => stores.checklist.forget(sessionId) },
};
