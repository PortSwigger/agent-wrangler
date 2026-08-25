// Pure logic for the chat view's activity grouping (chat-view.js), split out so it
// can be unit-tested without a DOM — the same split search-browse.js / layout.js /
// diff.js already use.
//
// Direction C's whole premise: prose reads first, machinery collapses. A run of
// consecutive tool events with no other event between them becomes ONE expandable
// activity chip, so a turn that read nine files reads as one line instead of nine.

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'view_image']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'tool_search_call']);

function classOf(name) {
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (SEARCH_TOOLS.has(name)) return 'search';
  return 'run';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function activityLabel(tools) {
  const counts = { read: 0, edit: 0, search: 0, run: 0 };
  for (const t of tools) counts[classOf(t.name)] += 1;
  const parts = [];
  if (counts.edit) parts.push(`Edited ${plural(counts.edit, 'file', 'files')}`);
  if (counts.read) parts.push(`Read ${plural(counts.read, 'file', 'files')}`);
  if (counts.search) parts.push(plural(counts.search, 'search', 'searches'));
  if (counts.run) parts.push(`Ran ${plural(counts.run, 'command', 'commands')}`);
  return parts.join(', ');
}

export function groupChatEvents(events) {
  const items = [];
  let run = null;
  const closeRun = () => {
    if (!run) return;
    items.push({
      type: 'activity',
      label: activityLabel(run),
      tools: run,
      adds: run.reduce((n, t) => n + (t.adds || 0), 0),
      dels: run.reduce((n, t) => n + (t.dels || 0), 0),
    });
    run = null;
  };
  for (const event of events || []) {
    if (event.kind === 'tool') {
      (run ||= []).push(event);
      continue;
    }
    closeRun();
    items.push({ type: event.kind, event });
  }
  closeRun();
  return items;
}
