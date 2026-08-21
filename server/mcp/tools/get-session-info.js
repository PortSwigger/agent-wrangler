import { deriveParentSession, sessionLabel } from '../../state-reader.js';

// Self-lookup: answers "where am I in the hierarchy" for the CALLER only, in one
// cheap call — no need to fetch list_sessions and scan for your own row. Reports
// two DIFFERENT, independently-nullable relations (see the tool description for
// why they must not be conflated), each with its own chain to root:
//   - parent / parentChain: the board-nesting relation (`parentSession`) — set at
//     spawn via `nest: true`, or later via attach_session/detach_session. This is
//     what "who is your parent" means in Agent Wrangler's own vocabulary.
//   - spawnedBy / spawnerChain: who actually called spawn_session/spawn_workflow
//     to launch you — set once at launch, only for that launch path. A session
//     dispatched from the board UI has spawnedBy: null even if later nested.
const MAX_CHAIN_DEPTH = 50;

// Walk `field` (parentSession or spawnedBy) from `startId` up to root, one raw
// mapping entry at a time via sessionManager.entryFor (covers archived ancestors
// too — deps.graph() only sees the live board). Every step goes through
// deriveParentSession so a legacy pre-migration worker entry (workflow.parent,
// no parentSession field) resolves the same way this chain and list_sessions'
// buildGraph do — reading raw entry.parentSession directly here would silently
// disagree with list_sessions for exactly that legacy shape. Bounded by depth
// AND a visited set — a chain shouldn't cycle, but this must never hang if one
// does (same convention as public/workflow.js's absorbed-parent walk and
// archive.js's descendantsOf).
function walkChain(sessionManager, taskStore, startId, field) {
  const chain = [];
  const seen = new Set();
  let id = startId || null;
  while (id && !seen.has(id) && chain.length < MAX_CHAIN_DEPTH) {
    seen.add(id);
    const entry = sessionManager.entryFor(id);
    if (!entry) break;
    const label = sessionLabel({ names: [entry.name, entry.lastLabel], intent: entry.intent, cwd: entry.cwd, fallback: id.slice(0, 8) }) || null;
    chain.push({ sessionId: id, label, task: taskStore.taskFor(id) ?? null });
    id = deriveParentSession(entry)[field] || null;
  }
  return chain;
}

export const getSessionInfoTool = {
  name: 'get_session_info',
  description:
    'Get YOUR OWN place in the Agent Wrangler hierarchy in one cheap call — your session id, '
    + 'label, task, and two DIFFERENT, independently-nullable relations. `parent`/`parentChain` is '
    + 'the board-nesting relation (`parentSession`) walked to root — this is what "who is your '
    + 'parent" means here; it is opt-in (set via spawn_session\'s `nest: true`, or later via '
    + 'attach_session/detach_session) and can change after launch. `spawnedBy`/`spawnerChain` is '
    + 'who actually called spawn_session/spawn_workflow to launch you, walked to root — set once '
    + 'at launch, only for that launch path; null if you were dispatched directly from the board '
    + 'UI. Either can be set with the other null — do not assume one implies the other. The same '
    + 'spawnedBy is also available at boot (and after a resume) as the AW_SPAWNER_SESSION_ID env '
    + 'var, but that var never reflects `parent`/nesting at all, and goes stale if you get '
    + 're-nested after launch — this tool always reads live state. `parentLabel`/`spawnedByLabel` '
    + 'name the id in the sibling field — use them, not the raw id, when telling the user about '
    + 'your parent or spawner. Read-only.',
  inputSchema: {},
  async handler({ deps, caller }) {
    if (!caller) return errorResult('No caller identity on this request — this tool answers for the calling session only.');
    const entry = deps.sessionManager.entryFor(caller);
    if (!entry) return errorResult('Caller session not found.');

    // Source the caller's OWN label/parent/spawnedBy from the same graph row
    // list_sessions reports, so the two tools can never disagree about the
    // caller itself (buildGraph already applies the legacy-worker fallback and
    // full label-resolution chain that a raw entry read alone would miss).
    const graphRow = deps.graph?.()?.sessions?.find((s) => s.sessionId === caller);
    const parent = graphRow ? (graphRow.parentSession ?? null) : deriveParentSession(entry).parentSession;
    const spawnedBy = graphRow ? (graphRow.spawnedBy ?? null) : deriveParentSession(entry).spawnedBy;
    const label = graphRow
      ? (graphRow.label ?? null)
      : sessionLabel({ names: [entry.name, entry.lastLabel], intent: entry.intent, cwd: entry.cwd, fallback: caller.slice(0, 8) }) || null;

    const parentChain = walkChain(deps.sessionManager, deps.taskStore, parent, 'parentSession');
    const spawnerChain = walkChain(deps.sessionManager, deps.taskStore, spawnedBy, 'spawnedBy');
    const structuredContent = {
      sessionId: caller,
      label,
      task: deps.taskStore.taskFor(caller) ?? null,
      parent,
      // Sits alongside the bare id — same reason spawn_session/spawn_workflow
      // return a label, not just an id: naming the parent to the user
      // shouldn't require digging into parentChain[0] for it.
      parentLabel: parentChain[0]?.label ?? null,
      parentChain,
      spawnedBy,
      spawnedByLabel: spawnerChain[0]?.label ?? null,
      spawnerChain,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
