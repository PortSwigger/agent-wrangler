import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teleportHandler } from './teleport.js';

function ctxWith(teleport) {
  const replies = [];
  let rebuilds = 0;
  return {
    replies,
    rebuilds: () => rebuilds,
    ctx: {
      sessionManager: { teleport },
      reply: (m) => replies.push(m),
      rebuild: async () => { rebuilds += 1; },
    },
  };
}

test('teleport handler acks with the new worktree and rebuilds', async () => {
  const t = ctxWith(async (id) => ({ sessionId: id, cwd: '/wt', branch: 'HEAD' }));
  await teleportHandler.handler({ sessionId: 'c' }, t.ctx);
  assert.deepEqual(t.replies, [{ type: 'teleported', sessionId: 'c', cwd: '/wt', branch: 'HEAD' }]);
  assert.equal(t.rebuilds(), 1);
});

test('teleport handler relays a refusal as a plain error, and does NOT rebuild', async () => {
  const t = ctxWith(async () => { throw new Error('nope'); });
  await teleportHandler.handler({ sessionId: 'c' }, t.ctx);
  assert.deepEqual(t.replies, [{ type: 'error', message: 'nope' }]);
  assert.equal(t.rebuilds(), 0);
});
