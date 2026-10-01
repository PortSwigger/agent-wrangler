import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChecklistStore } from './store.js';
import { addChecklistItemTool } from './tools/add-checklist-item.js';
import { updateChecklistItemTool } from './tools/update-checklist-item.js';
import { removeChecklistItemTool } from './tools/remove-checklist-item.js';
import { listChecklistTool } from './tools/list-checklist.js';
import {
  checklistAddHandler, checklistUpdateHandler, checklistRemoveHandler, checklistReorderHandler,
} from './handlers.js';

// The per-session checklist, and the first builtin extension: a short list the
// human edits on the board and the launched agent edits through four MCP tools,
// both writing the same store. Enablement is the loader's `extensions.checklist`
// (default ON); a retired `checklistEnabled: false` is carried over by
// config-store's migrateRetiredFlags.
//
// Everything reaches the server through the `host` façade. `board:rebuild` is the
// only capability needed — the store is the extension's own (`host.stores`) and
// the caller identity is the card id the MCP layer resolves, so no session or
// task read is involved.
//
// DATA: the store keeps writing `<DATA_DIR>/checklists.json` (see store.js), NOT a
// per-extension directory, so every list that existed before the extraction loads
// unchanged.
export default {
  id: 'checklist',
  label: 'Per-session checklist',
  help: 'A short checklist beside each session\'s terminal that you and the agent both edit. Turning it off removes the panel, the four checklist tools and the checklist skill; stored lists are kept.',
  description: 'A per-session checklist the human and the agent share.',
  author: 'Agent Wrangler',
  defaultEnabled: true,
  dir: path.dirname(fileURLToPath(import.meta.url)),
  requires: ['board:rebuild'],
  stores: { checklist: () => new ChecklistStore() },
  tools: [addChecklistItemTool, updateChecklistItemTool, removeChecklistItemTool, listChecklistTool],
  handlers: [checklistAddHandler, checklistUpdateHandler, checklistRemoveHandler, checklistReorderHandler],
  // Same key the board has always carried the whole store under: one snapshot,
  // not per-card enrichment, because only the selected session's panel reads it.
  graph: ({ host }) => ({ checklists: host.stores.checklist.snapshot() }),
  // Archive is "set aside", not end-of-life, so an archived card keeps its list
  // and a resume restores it; only the purge (the card leaving mappings.json)
  // drops it.
  session: {
    onPurge: ({ sessionId, host }) => { host.stores.checklist.forget(sessionId); },
  },
  skills: ['checklist'],
  client: 'public/index.js',
  styles: 'public/styles.css',
};
