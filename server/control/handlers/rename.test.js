import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameHandler } from './rename.js';

function ctx(graphSession) {
  const calls = { rename: [], rebuild: 0 };
  return {
    calls,
    sessionManager: { rename: (sid, name, meta) => calls.rename.push({ sid, name, meta }) },
    sessionFromGraph: () => graphSession ?? null,
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('rename: passes name + graph cwd/intent to sessionManager.rename', async () => {
  const c = ctx({ cwd: '/repo', intent: 'do a thing' });
  await renameHandler.handler({ type: 'rename', sessionId: 'S1', name: 'New name' }, c);
  assert.deepEqual(c.calls.rename, [{ sid: 'S1', name: 'New name', meta: { cwd: '/repo', intent: 'do a thing' } }]);
  assert.equal(c.calls.rebuild, 1);
});

test('rename: passes undefined cwd/intent when session is off-graph', async () => {
  const c = ctx(null);
  await renameHandler.handler({ type: 'rename', sessionId: 'S1', name: 'X' }, c);
  assert.deepEqual(c.calls.rename[0].meta, { cwd: undefined, intent: undefined });
});
