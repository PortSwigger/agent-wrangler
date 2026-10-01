import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryHandler, setMemoryHandler } from './handlers.js';

// The handlers get the extension's own `host` façade (not the board's ctx):
// there is no per-socket reply, so the answer is an `ext:task-memory` broadcast.
function host(memory = {}) {
  const calls = { write: [], broadcast: [] };
  return {
    calls,
    stores: {
      taskMemory: {
        read: (taskId) => memory[taskId] ?? '',
        write: (taskId, md) => calls.write.push({ taskId, md }),
      },
    },
    broadcast: (obj) => calls.broadcast.push(obj),
  };
}

test('get-memory: broadcasts the stored markdown for the task', async () => {
  const h = host({ T1: '# My memory' });
  await getMemoryHandler.handler({ type: 'get-memory', taskId: 'T1' }, h);
  assert.deepEqual(h.calls.broadcast, [{ kind: 'memory', taskId: 'T1', md: '# My memory' }]);
});

test('get-memory: broadcasts an empty string for an unknown task', async () => {
  const h = host({});
  await getMemoryHandler.handler({ type: 'get-memory', taskId: 'T_UNKNOWN' }, h);
  assert.deepEqual(h.calls.broadcast, [{ kind: 'memory', taskId: 'T_UNKNOWN', md: '' }]);
});

test('set-memory: writes the markdown to the memory store (no reply, no broadcast — the watcher fans out)', async () => {
  const h = host();
  await setMemoryHandler.handler({ type: 'set-memory', taskId: 'T1', md: '# Updated' }, h);
  assert.deepEqual(h.calls.write, [{ taskId: 'T1', md: '# Updated' }]);
  assert.deepEqual(h.calls.broadcast, []);
});

test('set-memory: writes empty string when md is absent', async () => {
  const h = host();
  await setMemoryHandler.handler({ type: 'set-memory', taskId: 'T1' }, h);
  assert.deepEqual(h.calls.write, [{ taskId: 'T1', md: '' }]);
});
