import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoFixPrChecksHandler } from './auto-fix-pr-checks.js';

function ctx(graphSession) {
  const calls = { set: [], rebuild: 0 };
  return {
    calls,
    sessionManager: {
      setAutoFixPrChecks: (sid, enabled, meta) => calls.set.push({ sid, enabled, meta }),
    },
    sessionFromGraph: () => graphSession ?? null,
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('auto-fix-pr-checks: stores the override and rebuilds', async () => {
  const c = ctx({ cwd: '/repo', intent: 'work' });
  await autoFixPrChecksHandler.handler({ type: 'auto-fix-pr-checks', sessionId: 'S1', enabled: false }, c);
  assert.equal(c.calls.set.length, 1);
  assert.equal(c.calls.set[0].sid, 'S1');
  assert.equal(c.calls.set[0].enabled, false);
  assert.deepEqual(c.calls.set[0].meta, { cwd: '/repo', intent: 'work' });
  assert.equal(c.calls.rebuild, 1);
});

test('auto-fix-pr-checks: coerces enabled to a boolean', async () => {
  const c = ctx(null);
  await autoFixPrChecksHandler.handler({ type: 'auto-fix-pr-checks', sessionId: 'S2', enabled: 1 }, c);
  assert.equal(c.calls.set[0].enabled, true);
});
