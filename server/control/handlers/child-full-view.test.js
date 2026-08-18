import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childFullViewHandler } from './child-full-view.js';

function ctx(graphSession) {
  const calls = { set: [], rebuild: 0 };
  return {
    calls,
    sessionManager: {
      setChildFullView: (sid, enabled, meta) => calls.set.push({ sid, enabled, meta }),
    },
    sessionFromGraph: () => graphSession ?? null,
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('set-child-full-view: stores the override and rebuilds', async () => {
  const c = ctx({ cwd: '/repo', intent: 'work' });
  await childFullViewHandler.handler({ type: 'set-child-full-view', sessionId: 'S1', enabled: true }, c);
  assert.equal(c.calls.set.length, 1);
  assert.equal(c.calls.set[0].sid, 'S1');
  assert.equal(c.calls.set[0].enabled, true);
  assert.deepEqual(c.calls.set[0].meta, { cwd: '/repo', intent: 'work' });
  assert.equal(c.calls.rebuild, 1);
});

test('set-child-full-view: coerces enabled to a boolean', async () => {
  const c = ctx(null);
  await childFullViewHandler.handler({ type: 'set-child-full-view', sessionId: 'S2', enabled: 0 }, c);
  assert.equal(c.calls.set[0].enabled, false);
});
