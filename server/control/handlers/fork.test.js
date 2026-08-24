import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forkHandler } from './fork.js';

// A cloud card must be refused BEFORE any of fork's id resolution runs. Its entry
// carries no liveSessionId, so `sourceId` would fall back to the CARD id and the
// launch would become `claude --resume --fork-session <card id>` — which fails open
// into a fresh, empty LOCAL session rather than erroring (CLAUDE.md's fails-open
// rule). Refusing early is the difference between a clear message and a blank card.
test('fork refuses a cloud session and never reaches sessionManager.fork', async () => {
  let forked = false;
  const ctx = {
    sessionFromGraph: () => null,
    sessionManager: {
      entryFor: () => ({ runtime: 'cloud', cwd: '/repo', cloud: { sessionId: 'session_a' } }),
      fork: async () => { forked = true; return { sessionId: 'x' }; },
    },
    reply: () => {},
    rebuild: async () => {},
    taskStore: { taskFor: () => null, assign: () => {} },
    memoryStore: { bindSession: () => {} },
  };
  await assert.rejects(() => forkHandler.handler({ sessionId: 'c' }, ctx), /can't be forked/);
  assert.equal(forked, false);
});
