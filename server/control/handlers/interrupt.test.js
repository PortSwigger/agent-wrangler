import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interruptHandler } from './interrupt.js';

function ctx({ tmux = 'cc_abc' } = {}) {
  const calls = [];
  return {
    calls,
    sessionFromGraph: () => ({ liveSessionId: 'live-1' }),
    tmuxFor: () => tmux,
    socketFor: () => 'sock',
    sendKeys: (name, keys, socket) => { calls.push({ name, keys, socket }); },
    reply: () => {},
  };
}

test('interrupt sends Escape to the session pane', async () => {
  const c = ctx();
  await interruptHandler.handler({ type: 'interrupt', sessionId: 'card-1' }, c);
  assert.deepEqual(c.calls, [{ name: 'cc_abc', keys: ['Escape'], socket: 'sock' }]);
});

test('interrupt on a session with no live pane is a no-op', async () => {
  const c = ctx({ tmux: null });
  await interruptHandler.handler({ type: 'interrupt', sessionId: 'card-1' }, c);
  assert.deepEqual(c.calls, []);
});
