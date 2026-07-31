import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMergeOnPassHandler } from './auto-merge-on-pass.js';

function ctx(graphSession) {
  const calls = { set: [], rebuild: 0 };
  return {
    calls,
    sessionManager: {
      setAutoMergeOnPass: (sid, enabled, meta) => calls.set.push({ sid, enabled, meta }),
    },
    sessionFromGraph: () => graphSession ?? null,
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('auto-merge-on-pass: stores the override and rebuilds', async () => {
  const c = ctx({ cwd: '/repo', intent: 'work' });
  await autoMergeOnPassHandler.handler({ type: 'auto-merge-on-pass', sessionId: 'S1', enabled: true }, c);
  assert.equal(c.calls.set.length, 1);
  assert.equal(c.calls.set[0].sid, 'S1');
  assert.equal(c.calls.set[0].enabled, true);
  assert.deepEqual(c.calls.set[0].meta, { cwd: '/repo', intent: 'work' });
  assert.equal(c.calls.rebuild, 1);
});

test('auto-merge-on-pass: coerces enabled to a boolean', async () => {
  const c = ctx(null);
  await autoMergeOnPassHandler.handler({ type: 'auto-merge-on-pass', sessionId: 'S2', enabled: 0 }, c);
  assert.equal(c.calls.set[0].enabled, false);
  assert.deepEqual(c.calls.set[0].meta, { cwd: undefined, intent: undefined });
});
