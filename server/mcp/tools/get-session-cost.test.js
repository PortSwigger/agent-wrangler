import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSessionCostTool } from './get-session-cost.js';

const deps = (sessions) => ({ graph: () => ({ sessions }) });

test('get_session_cost requires caller identity', async () => {
  const out = await getSessionCostTool.handler({ deps: deps([]), caller: null });
  assert.equal(out.isError, true);
});

test('get_session_cost rejects a caller not on the board', async () => {
  const out = await getSessionCostTool.handler({ deps: deps([{ sessionId: 'OTHER', usd: 3 }]), caller: 'S1' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not found/);
});

test('get_session_cost reports the caller\'s own card figures, with sub-agents summed', async () => {
  const out = await getSessionCostTool.handler({
    deps: deps([
      { sessionId: 'OTHER', agent: 'claude', usd: 99 },
      {
        sessionId: 'S1', agent: 'claude', usd: 1.5, advisorUsd: 0.25,
        tokens: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
        subAgents: [{ usd: 0.2 }, { usd: null }, { usd: 0.3 }],
      },
    ]),
    caller: 'S1',
  });
  assert.deepEqual(out.structuredContent, {
    sessionId: 'S1', usd: 1.5, estimated: false, subAgentUsd: 0.5, advisorUsd: 0.25,
    tokens: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
  });
});

test('get_session_cost marks a Codex figure estimated and tolerates an uncosted row', async () => {
  const out = await getSessionCostTool.handler({ deps: deps([{ sessionId: 'S1', agent: 'codex', usd: null }]), caller: 'S1' });
  assert.deepEqual(out.structuredContent, {
    sessionId: 'S1', usd: null, estimated: true, subAgentUsd: 0, advisorUsd: 0, tokens: null,
  });
});
