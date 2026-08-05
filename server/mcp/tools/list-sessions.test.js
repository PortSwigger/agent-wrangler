import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSessionsTool } from './list-sessions.js';

function deps() {
  return {
    graph: () => ({
      sessions: [
        {
          sessionId: 'CARD1', label: 'Alpha', agent: 'claude', status: 'idle', cwd: '/a', managed: true,
          parentSession: 'ORCH', spawnedBy: null,
        },
        {
          sessionId: 'CARD2', label: 'Beta', agent: 'codex', status: 'working', cwd: '/b', managed: false,
        },
      ],
    }),
    taskStore: {
      taskFor: (sid) => (sid === 'CARD1' ? { id: 'T1', name: 'Login' } : null),
    },
  };
}

test('list_sessions maps the board and flags the caller', async () => {
  const out = await listSessionsTool.handler({ deps: deps(), caller: 'CARD1' });
  assert.deepEqual(out.structuredContent.caller, {
    sessionId: 'CARD1', task: { id: 'T1', name: 'Login' }, parentSession: 'ORCH', spawnedBy: null,
  });
  assert.equal(out.structuredContent.sessions.length, 2);
  const alpha = out.structuredContent.sessions.find((s) => s.sessionId === 'CARD1');
  assert.deepEqual(alpha, {
    sessionId: 'CARD1', label: 'Alpha', agent: 'claude', status: 'idle', managed: true, cwd: '/a',
    task: { id: 'T1', name: 'Login' }, parentSession: 'ORCH', spawnedBy: null, isCaller: true,
  });
  const beta = out.structuredContent.sessions.find((s) => s.sessionId === 'CARD2');
  assert.equal(beta.isCaller, false);
  assert.equal(beta.task, null);
  assert.equal(beta.managed, false);
  assert.equal(beta.parentSession, null);
  assert.equal(beta.spawnedBy, null);
  assert.equal(out.content[0].type, 'text');
});

test('list_sessions yields a null caller block when the request had no identity', async () => {
  const out = await listSessionsTool.handler({ deps: deps(), caller: null });
  assert.equal(out.structuredContent.caller, null);
  assert.ok(out.structuredContent.sessions.every((s) => s.isCaller === false));
});

test('list_sessions tolerates an empty/absent graph', async () => {
  const out = await listSessionsTool.handler({ deps: { graph: () => null, taskStore: { taskFor: () => null } }, caller: 'X' });
  assert.deepEqual(out.structuredContent.sessions, []);
});
