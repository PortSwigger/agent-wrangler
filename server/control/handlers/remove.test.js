import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeHandler } from './remove.js';

function ctx(overrides = {}) {
  const calls = { kill: [], forget: [], unassign: [], memoryForget: [], mailForget: [], checklistForget: [] };
  return {
    calls,
    sessionManager: {
      killForSession: async (sid) => { calls.kill.push(sid); return []; },
      forget: (sid) => calls.forget.push(sid),
    },
    taskStore: { unassign: (sid) => calls.unassign.push(sid) },
    memoryStore: { forget: (sid) => calls.memoryForget.push(sid) },
    mailStore: { forget: (sid) => calls.mailForget.push(sid) },
    checklistStore: { forget: (sid) => calls.checklistForget.push(sid) },
    rebuild: async () => {},
    ...overrides,
  };
}

test('remove: kills, forgets the session, unassigns the task, memory, mailbox and checklist', async () => {
  const c = ctx();
  await removeHandler.handler({ type: 'remove', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.kill, ['S1']);
  assert.deepEqual(c.calls.forget, ['S1']);
  assert.deepEqual(c.calls.unassign, ['S1']);
  assert.deepEqual(c.calls.memoryForget, ['S1']);
  assert.deepEqual(c.calls.mailForget, ['S1']);
  // Purge is the only place a checklist is dropped — archive deliberately keeps it.
  assert.deepEqual(c.calls.checklistForget, ['S1']);
});

test('remove: proceeds even when killForSession throws (already gone)', async () => {
  const c = ctx({
    sessionManager: {
      killForSession: async () => { throw new Error('no such process'); },
      forget: (sid) => c.calls.forget.push(sid),
    },
  });
  await assert.doesNotReject(removeHandler.handler({ type: 'remove', sessionId: 'S1' }, c));
  assert.deepEqual(c.calls.forget, ['S1']);
});
