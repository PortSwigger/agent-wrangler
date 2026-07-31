import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subagentDetailHandler } from './subagent-detail.js';

test('replies with the detail keyed by subagentId, targeted (via ctx.reply)', async () => {
  const replies = [];
  const ctx = {
    reply: (o) => replies.push(o),
    subagentDetail: async (sid, aid) => ({ prompt: `p:${sid}:${aid}`, toolCalls: [], result: 'r' }),
  };
  await subagentDetailHandler.handler({ type: 'subagent-detail', sessionId: 'S', subagentId: 'A' }, ctx);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], { type: 'subagent-detail', sessionId: 'S', subagentId: 'A', prompt: 'p:S:A', toolCalls: [], result: 'r' });
});

test('resolves the card id to its conversation id (liveSessionId) before fetching, but replies with the CARD id', async () => {
  const seen = [];
  const replies = [];
  const ctx = {
    reply: (o) => replies.push(o),
    sessionFromGraph: (id) => (id === 'CARD' ? { liveSessionId: 'CONV' } : null),
    subagentDetail: async (sid) => { seen.push(sid); return { prompt: 'p', toolCalls: [], result: 'r' }; },
  };
  await subagentDetailHandler.handler({ sessionId: 'CARD', subagentId: 'A' }, ctx);
  assert.deepEqual(seen, ['CONV']);
  // The client correlates replies by the id it SENT (the card id) — echoing convId
  // back instead would never match subagentModalReq.sessionId client-side.
  assert.equal(replies[0].sessionId, 'CARD');
});

test('falls back to the card id when the graph has no liveSessionId (legacy entry)', async () => {
  const seen = [];
  const ctx = {
    reply: () => {},
    sessionFromGraph: () => ({ liveSessionId: null }),
    subagentDetail: async (sid) => { seen.push(sid); return { prompt: 'p', toolCalls: null, result: 'r' }; },
  };
  await subagentDetailHandler.handler({ sessionId: 'LEGACY', subagentId: 'A' }, ctx);
  assert.deepEqual(seen, ['LEGACY']);
});

test('passes a legacy toolCalls: null through unchanged', async () => {
  const replies = [];
  const ctx = {
    reply: (o) => replies.push(o),
    subagentDetail: async () => ({ prompt: 'p', toolCalls: null, result: 'r' }),
  };
  await subagentDetailHandler.handler({ sessionId: 'S', subagentId: 'L' }, ctx);
  assert.equal(replies[0].toolCalls, null);
});
