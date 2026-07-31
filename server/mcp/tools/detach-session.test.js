import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachSessionTool } from './detach-session.js';

function deps(entries) {
  const calls = { detach: [], rebuild: 0 };
  return {
    calls,
    d: {
      sessionManager: {
        entryFor: (id) => entries[id] ?? null,
        detachSession: (id) => { calls.detach.push(id); return true; },
      },
      rebuild: async () => { calls.rebuild += 1; },
    },
  };
}

test('detach_session requires session_id', async () => {
  const { d } = deps({});
  const out = await detachSessionTool.handler({ deps: d }, { session_id: '  ' });
  assert.equal(out.isError, true);
});

test('detach_session rejects an unknown session', async () => {
  const { d, calls } = deps({});
  const out = await detachSessionTool.handler({ deps: d }, { session_id: 'ghost' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown session/);
  assert.equal(calls.detach.length, 0);
});

test('detach_session rejects a workflow worker', async () => {
  const { d, calls } = deps({ S1: { parentSession: 'ORCH' }, ORCH: { workflow: { issue: 'ENT-1' } } });
  const out = await detachSessionTool.handler({ deps: d }, { session_id: 'S1' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /workflow worker/);
  assert.equal(calls.detach.length, 0);
});

test('detach_session promotes a plain nested child and rebuilds', async () => {
  const { d, calls } = deps({ S1: { parentSession: 'REVIEWED' }, REVIEWED: {} });
  const out = await detachSessionTool.handler({ deps: d }, { session_id: 'S1' });
  assert.deepEqual(out.structuredContent, { session_id: 'S1', detached: true });
  assert.deepEqual(calls.detach, ['S1']);
  assert.equal(calls.rebuild, 1);
});
