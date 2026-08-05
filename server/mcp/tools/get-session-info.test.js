import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSessionInfoTool } from './get-session-info.js';

function deps(entries, tasks = {}) {
  return {
    sessionManager: { entryFor: (id) => entries[id] ?? null },
    taskStore: { taskFor: (id) => tasks[id] ?? null },
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
    sessionId: 'S1', label: 'Solo', task: null, parent: null, parentChain: [], spawnedBy: null, spawnerChain: [],
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
    }, { ORCH: { id: 'T1', name: 'Benchmark' } }),
    caller: 'S1',
  });
  assert.equal(out.structuredContent.parent, 'ORCH');
  assert.deepEqual(out.structuredContent.parentChain, [
    { sessionId: 'ORCH', label: 'Orchestrator', task: { id: 'T1', name: 'Benchmark' } },
  ]);
  assert.equal(out.structuredContent.spawnedBy, null);
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
  assert.deepEqual(out.structuredContent.spawnerChain, [
    { sessionId: 'PREV', label: 'Previous', task: null },
  ]);
  assert.equal(out.structuredContent.parent, null);
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
