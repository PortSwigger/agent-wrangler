import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRebaseLinkedPrHandler } from './auto-rebase-linked-pr.js';

test('auto-rebase-linked-pr stores an explicit per-session opt-in and rebuilds', async () => {
  const calls = [];
  const ctx = {
    sessionManager: { setAutoRebaseLinkedPr: (...args) => calls.push(args) },
    sessionFromGraph: () => ({ cwd: '/repo', intent: 'work' }),
    rebuild: async () => { calls.push('rebuild'); },
  };

  await autoRebaseLinkedPrHandler.handler({
    type: 'auto-rebase-linked-pr', sessionId: 'S1', enabled: 1,
  }, ctx);

  assert.deepEqual(calls, [
    ['S1', true, { cwd: '/repo', intent: 'work' }],
    'rebuild',
  ]);
});
