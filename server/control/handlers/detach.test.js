import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachError, detachHandler } from './detach.js';

function sessionManager(entries) {
  return { entryFor: (id) => entries[id] ?? null, detachSession: () => true };
}

test('detachError: unknown session', () => {
  assert.match(detachError('ghost', sessionManager({})), /Unknown session ghost/);
});

test('detachError: not nested — nothing to promote', () => {
  const sm = sessionManager({ S1: {} });
  assert.match(detachError('S1', sm), /already a full top-level session/);
});

test('detachError: blocked for a workflow worker, naming the orchestrator', () => {
  const sm = sessionManager({
    S1: { parentSession: 'ORCH' },
    ORCH: { workflow: { issue: 'ENT-1' } },
  });
  const err = detachError('S1', sm);
  assert.match(err, /workflow worker/);
  assert.match(err, /ORCH/);
});

test('detachError: null — a plain nested child (parent has no workflow marker) may be promoted', () => {
  const sm = sessionManager({
    S1: { parentSession: 'REVIEWED' },
    REVIEWED: {},
  });
  assert.equal(detachError('S1', sm), null);
});

function ctx() {
  const calls = { detach: [], reply: [], rebuild: 0 };
  return {
    calls,
    sessionManager: {
      entryFor: (id) => (id === 'S1' ? { parentSession: 'REVIEWED' } : (id === 'REVIEWED' ? {} : null)),
      detachSession: (id) => { calls.detach.push(id); return true; },
    },
    reply: (obj) => calls.reply.push(obj),
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('detachHandler: detaches and rebuilds when the guard passes', async () => {
  const c = ctx();
  await detachHandler.handler({ type: 'detach', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.detach, ['S1']);
  assert.equal(c.calls.rebuild, 1);
  assert.equal(c.calls.reply.length, 0);
});

test('detachHandler: replies with an error and never mutates when the guard fails', async () => {
  const c = ctx();
  await detachHandler.handler({ type: 'detach', sessionId: 'ghost' }, c);
  assert.equal(c.calls.detach.length, 0);
  assert.equal(c.calls.rebuild, 0);
  assert.equal(c.calls.reply.length, 1);
  assert.equal(c.calls.reply[0].type, 'error');
  assert.match(c.calls.reply[0].message, /Unknown session ghost/);
});
