import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryHandler, setMemoryHandler } from './memory.js';

function ctx(memory = {}) {
  const calls = { write: [], sent: [] };
  return {
    calls,
    memoryStore: {
      read: (taskId) => memory[taskId] ?? '',
      write: (taskId, md) => calls.write.push({ taskId, md }),
    },
    reply: (obj) => calls.sent.push(obj),
  };
}

test('get-memory: replies with the stored markdown for the task', async () => {
  const c = ctx({ T1: '# My memory' });
  await getMemoryHandler.handler({ type: 'get-memory', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.sent, [{ type: 'memory', taskId: 'T1', md: '# My memory' }]);
});

test('get-memory: replies with empty string for an unknown task', async () => {
  const c = ctx({});
  await getMemoryHandler.handler({ type: 'get-memory', taskId: 'T_UNKNOWN' }, c);
  assert.deepEqual(c.calls.sent, [{ type: 'memory', taskId: 'T_UNKNOWN', md: '' }]);
});

test('set-memory: writes the markdown to the memory store (no reply, no rebuild)', async () => {
  const c = ctx();
  await setMemoryHandler.handler({ type: 'set-memory', taskId: 'T1', md: '# Updated' }, c);
  assert.deepEqual(c.calls.write, [{ taskId: 'T1', md: '# Updated' }]);
  assert.deepEqual(c.calls.sent, []);
});

test('set-memory: writes empty string when md is absent', async () => {
  const c = ctx();
  await setMemoryHandler.handler({ type: 'set-memory', taskId: 'T1' }, c);
  assert.deepEqual(c.calls.write, [{ taskId: 'T1', md: '' }]);
});
