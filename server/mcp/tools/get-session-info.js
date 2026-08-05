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

// Walk `field` (parentSession or spawnedBy) from `startId` up to root. Bounded by
// depth AND a visited set — a chain shouldn't cycle, but this must never hang if
// one does (same convention as public/workflow.js's absorbed-parent walk and
// archive.js's descendantsOf).
function walkChain(sessionManager, taskStore, startId, field) {
  const chain = [];
  const seen = new Set();
  let id = startId || null;
  while (id && !seen.has(id) && chain.length < MAX_CHAIN_DEPTH) {
    seen.add(id);
    const entry = sessionManager.entryFor(id);
    if (!entry) break;
    chain.push({ sessionId: id, label: entry.name || null, task: taskStore.taskFor(id) ?? null });
    id = entry[field] || null;
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
    + 'spawnedBy is also available at boot as the AW_SPAWNER_SESSION_ID env var, but only this '
    + 'tool stays correct if you get re-nested after launch. Read-only.',
  inputSchema: {},
  async handler({ deps, caller }) {
    if (!caller) return errorResult('No caller identity on this request — this tool answers for the calling session only.');
    const entry = deps.sessionManager.entryFor(caller);
    if (!entry) return errorResult('Caller session not found.');

    const structuredContent = {
      sessionId: caller,
      label: entry.name || null,
      task: deps.taskStore.taskFor(caller) ?? null,
      parent: entry.parentSession || null,
      parentChain: walkChain(deps.sessionManager, deps.taskStore, entry.parentSession, 'parentSession'),
      spawnedBy: entry.spawnedBy || null,
      spawnerChain: walkChain(deps.sessionManager, deps.taskStore, entry.spawnedBy, 'spawnedBy'),
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
