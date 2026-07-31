import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachSessionTool } from './attach-session.js';

function deps(sessions, taskById = {}) {
  const calls = { attach: [], rebuild: 0 };
  return {
    calls,
    d: {
      sessionManager: { attachSession: (sid, pid) => { calls.attach.push({ sid, pid }); return true; } },
      graph: () => ({ sessions }),
      taskStore: { taskFor: (id) => taskById[id] ?? null },
      rebuild: async () => { calls.rebuild += 1; },
    },
  };
}

test('attach_session requires both ids', async () => {
  const { d } = deps([]);
  const missingParent = await attachSessionTool.handler({ deps: d }, { session_id: 'S1' });
  assert.equal(missingParent.isError, true);
  const missingSession = await attachSessionTool.handler({ deps: d }, { parent_session_id: 'S2' });
  assert.equal(missingSession.isError, true);
});

test('attach_session rejects a cycle', async () => {
  const sessions = [{ sessionId: 'A' }, { sessionId: 'B', parentSession: 'A' }];
  const { d, calls } = deps(sessions, { A: { id: 'T1', name: 'T' }, B: { id: 'T1', name: 'T' } });
  const out = await attachSessionTool.handler({ deps: d }, { session_id: 'A', parent_session_id: 'B' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /cycle/);
  assert.equal(calls.attach.length, 0);
});

test('attach_session rejects a cross-task target', async () => {
  const sessions = [{ sessionId: 'S1' }, { sessionId: 'S2' }];
  const { d, calls } = deps(sessions, { S1: { id: 'T1', name: 'Alpha' }, S2: { id: 'T2', name: 'Beta' } });
  const out = await attachSessionTool.handler({ deps: d }, { session_id: 'S1', parent_session_id: 'S2' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Alpha/);
  assert.equal(calls.attach.length, 0);
});

test('attach_session attaches a valid same-task pair and rebuilds', async () => {
  const sessions = [{ sessionId: 'S1' }, { sessionId: 'S2' }];
  const { d, calls } = deps(sessions, { S1: { id: 'T1', name: 'Alpha' }, S2: { id: 'T1', name: 'Alpha' } });
  const out = await attachSessionTool.handler({ deps: d }, { session_id: 'S1', parent_session_id: 'S2' });
  assert.deepEqual(out.structuredContent, { session_id: 'S1', parent_session_id: 'S2', attached: true });
  assert.deepEqual(calls.attach, [{ sid: 'S1', pid: 'S2' }]);
  assert.equal(calls.rebuild, 1);
});
