import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartTmuxHandler } from './restart-tmux.js';

function ctx(stale) {
  const calls = [];
  return {
    calls,
    staleGuiSession: () => stale,
    sessionManager: { killTmuxServer: async () => { calls.push('kill'); } },
    recheckGuiSession: async () => { calls.push('recheck'); },
    rebuild: async () => { calls.push('rebuild'); },
    reply: (obj) => calls.push(obj),
  };
}

test('restart-tmux: kills the server, re-runs the check, rebuilds, then replies', async () => {
  const c = ctx({ socket: 'aw-1' });
  await restartTmuxHandler.handler({ type: 'restart-tmux' }, c);
  assert.deepEqual(c.calls, ['kill', 'recheck', 'rebuild', { type: 'restart-tmux-done' }]);
});

test('restart-tmux: refused when the tmux server is not in an old session', async () => {
  const c = ctx(null);
  await assert.rejects(restartTmuxHandler.handler({ type: 'restart-tmux' }, c), /nothing to restart/);
  assert.deepEqual(c.calls, []);
});
