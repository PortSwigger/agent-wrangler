import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSessionInfoTool } from './get-session-info.js';

function deps(entries, { tasks = {}, graphSessions = null } = {}) {
  return {
    sessionManager: { entryFor: (id) => entries[id] ?? null },
    taskStore: { taskFor: (id) => tasks[id] ?? null },
    graph: graphSessions ? () => ({ sessions: graphSessions }) : undefined,
  };
}

test('get_session_info requires caller identity', async () => {
  const out = await getSessionInfoTool.handler({ deps: deps({}), caller: null });
  assert.equal(out.isError, true);
});

test('get_session_info rejects an unmapped caller', async () => {
  const out = await getSessionInfoTool.handler({ deps: deps({}), caller: 'ghost' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not found/);
});

test('get_session_info reports both relations null for a plain top-level session', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({ S1: { name: 'Solo' } }),
    caller: 'S1',
  });
  assert.deepEqual(out.structuredContent, {
    sessionId: 'S1', label: 'Solo', task: null,
    parent: null, parentLabel: null, parentChain: [],
    spawnedBy: null, spawnedByLabel: null, spawnerChain: [],
  });
});

// Mirrors the real case that motivated this tool: a session dispatched from the
// board UI (no caller identity at launch, so spawnedBy never got set) then nested
// under an orchestrator via attach_session (parentSession only).
test('get_session_info: nested-but-not-spawned session reports parent without spawnedBy', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({
      S1: { name: 'Worker', parentSession: 'ORCH' },
      ORCH: { name: 'Orchestrator' },
    }, { tasks: { ORCH: { id: 'T1', name: 'Benchmark' } } }),
    caller: 'S1',
  });
  assert.equal(out.structuredContent.parent, 'ORCH');
  // parentLabel sits alongside the bare id for the same reason spawn_session's
  // result does — a caller reporting its parent to the user needs a name, not
  // a raw id, without having to dig into parentChain[0] for it.
  assert.equal(out.structuredContent.parentLabel, 'Orchestrator');
  assert.deepEqual(out.structuredContent.parentChain, [
    { sessionId: 'ORCH', label: 'Orchestrator', task: { id: 'T1', name: 'Benchmark' } },
  ]);
  assert.equal(out.structuredContent.spawnedBy, null);
  assert.equal(out.structuredContent.spawnedByLabel, null);
  assert.deepEqual(out.structuredContent.spawnerChain, []);
});

test('get_session_info: spawned-but-not-nested session reports spawnedBy without parent', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({
      S1: { name: 'Handoff', spawnedBy: 'PREV' },
      PREV: { name: 'Previous' },
    }),
    caller: 'S1',
  });
  assert.equal(out.structuredContent.spawnedBy, 'PREV');
  assert.equal(out.structuredContent.spawnedByLabel, 'Previous');
  assert.deepEqual(out.structuredContent.spawnerChain, [
    { sessionId: 'PREV', label: 'Previous', task: null },
  ]);
  assert.equal(out.structuredContent.parent, null);
  assert.equal(out.structuredContent.parentLabel, null);
  assert.deepEqual(out.structuredContent.parentChain, []);
});

test('get_session_info walks a multi-level chain to root', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({
      S1: { name: 'Leaf', parentSession: 'MID' },
      MID: { name: 'Middle', parentSession: 'ROOT' },
      ROOT: { name: 'Root' },
    }),
    caller: 'S1',
  });
  assert.deepEqual(out.structuredContent.parentChain.map((c) => c.sessionId), ['MID', 'ROOT']);
});

test('get_session_info stops at a chain link that is no longer mapped', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({ S1: { name: 'Leaf', parentSession: 'GONE' } }),
    caller: 'S1',
  });
  assert.deepEqual(out.structuredContent.parentChain, []);
});

test('get_session_info never hangs on a cyclic chain', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({
      S1: { name: 'A', spawnedBy: 'S2' },
      S2: { name: 'B', spawnedBy: 'S1' },
    }),
    caller: 'S1',
  });
  assert.deepEqual(out.structuredContent.spawnerChain.map((c) => c.sessionId), ['S2', 'S1']);
});

// A legacy pre-migration worker entry carries `workflow: {parent: <id>}` instead
// of a real `parentSession` field. buildGraph (and therefore list_sessions) folds
// that into `parentSession` via deriveParentSession's legacy-worker fallback —
// this tool must agree, not just read the raw (absent) field.
test('get_session_info resolves a legacy worker\'s parentSession the same way list_sessions does', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({
      S1: { name: 'LegacyWorker', workflow: { parent: 'ORCH' } },
      ORCH: { name: 'Orchestrator' },
    }),
    caller: 'S1',
  });
  assert.equal(out.structuredContent.parent, 'ORCH');
  assert.deepEqual(out.structuredContent.parentChain, [{ sessionId: 'ORCH', label: 'Orchestrator', task: null }]);
});

// When the caller's row IS on the live graph, the caller's own label/parent/
// spawnedBy must come from that row (not a raw re-derivation) so get_session_info
// can never disagree with list_sessions about the caller itself.
test('get_session_info sources the caller\'s own fields from the graph row when available', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps(
      { S1: { name: 'RawName', parentSession: 'RAW_PARENT' } },
      { graphSessions: [{ sessionId: 'S1', label: 'Graph-resolved label', parentSession: 'ORCH', spawnedBy: 'PREV' }] },
    ),
    caller: 'S1',
  });
  assert.equal(out.structuredContent.label, 'Graph-resolved label');
  assert.equal(out.structuredContent.parent, 'ORCH');
  assert.equal(out.structuredContent.spawnedBy, 'PREV');
});

test('get_session_info falls back to the raw entry when the caller is not (yet) on the graph', async () => {
  const out = await getSessionInfoTool.handler({
    deps: deps({ S1: { name: 'RawName', parentSession: 'RAW_PARENT' } }, { graphSessions: [] }),
    caller: 'S1',
  });
  assert.equal(out.structuredContent.label, 'RawName');
  assert.equal(out.structuredContent.parent, 'RAW_PARENT');
});
