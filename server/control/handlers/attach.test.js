import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachError, attachHandler } from './attach.js';

const taskStore = (taskById) => ({ taskFor: (id) => taskById[id] ?? null });

test('attachError: missing ids', () => {
  assert.match(attachError('', 'P', { sessions: [], taskStore: taskStore({}) }), /required/);
  assert.match(attachError('S', '', { sessions: [], taskStore: taskStore({}) }), /required/);
});

test('attachError: cannot attach a session to itself', () => {
  const sessions = [{ sessionId: 'S1' }];
  assert.match(attachError('S1', 'S1', { sessions, taskStore: taskStore({}) }), /itself/);
});

test('attachError: unknown session or unknown target', () => {
  const sessions = [{ sessionId: 'S1' }];
  assert.match(attachError('ghost', 'S1', { sessions, taskStore: taskStore({}) }), /Unknown session ghost/);
  assert.match(attachError('S1', 'ghost', { sessions, taskStore: taskStore({}) }), /Unknown session ghost/);
});

test('attachError: refuses re-attaching to the session\'s own current parent (no-op)', () => {
  const sessions = [{ sessionId: 'S', parentSession: 'P' }, { sessionId: 'P' }];
  const t = taskStore({ S: { id: 'T1', name: 'T' }, P: { id: 'T1', name: 'T' } });
  const err = attachError('S', 'P', { sessions, taskStore: t });
  assert.match(err, /already attached/);
});

test('attachError: refuses a cycle — target is already a descendant of the session being moved', () => {
  const sessions = [
    { sessionId: 'A' },
    { sessionId: 'B', parentSession: 'A' },
    { sessionId: 'C', parentSession: 'B' },
  ];
  const t = taskStore({ A: { id: 'T1', name: 'T' }, B: { id: 'T1', name: 'T' }, C: { id: 'T1', name: 'T' } });
  const err = attachError('A', 'C', { sessions, taskStore: t });
  assert.match(err, /cycle/);
});

test('attachError: refuses cross-task targets, naming both tasks', () => {
  const sessions = [{ sessionId: 'S1' }, { sessionId: 'S2' }];
  const t = taskStore({ S1: { id: 'T1', name: 'Alpha' }, S2: { id: 'T2', name: 'Beta' } });
  const err = attachError('S1', 'S2', { sessions, taskStore: t });
  assert.match(err, /Alpha/);
  assert.match(err, /Beta/);
});

test('attachError: cross-task check treats "no task" (Ad-hoc) as a real, matchable bucket', () => {
  const sessions = [{ sessionId: 'S1' }, { sessionId: 'S2' }];
  const err = attachError('S1', 'S2', { sessions, taskStore: taskStore({}) });
  assert.equal(err, null);
});

test('attachError: null (allowed) for a same-task, non-cyclic, valid pair', () => {
  const sessions = [{ sessionId: 'S1' }, { sessionId: 'S2' }];
  const t = taskStore({ S1: { id: 'T1', name: 'Alpha' }, S2: { id: 'T1', name: 'Alpha' } });
  assert.equal(attachError('S1', 'S2', { sessions, taskStore: t }), null);
});

// Nesting only ever renders one level deep (computeAbsorption in
// public/workflow.js pops a grandchild back out to top-level). These two
// checks keep that invariant true of the data, not just the rendering: no
// Attach may create a session at depth > 1.
test('attachError: refuses attaching under a target that is itself already nested', () => {
  const sessions = [{ sessionId: 'A' }, { sessionId: 'B', parentSession: 'A' }, { sessionId: 'S' }];
  const t = taskStore({ A: { id: 'T1', name: 'T' }, B: { id: 'T1', name: 'T' }, S: { id: 'T1', name: 'T' } });
  const err = attachError('S', 'B', { sessions, taskStore: t });
  assert.match(err, /itself nested/);
});

test('attachError: refuses moving a session that currently has its own same-task children', () => {
  const sessions = [{ sessionId: 'S' }, { sessionId: 'Child', parentSession: 'S' }, { sessionId: 'P' }];
  const t = taskStore({ S: { id: 'T1', name: 'T' }, Child: { id: 'T1', name: 'T' }, P: { id: 'T1', name: 'T' } });
  const err = attachError('S', 'P', { sessions, taskStore: t });
  assert.match(err, /own nested children/);
});

test('attachError: a session\'s children on a DIFFERENT task do not block attaching it (they already render as orphans)', () => {
  const sessions = [{ sessionId: 'S' }, { sessionId: 'Child', parentSession: 'S' }, { sessionId: 'P' }];
  const t = taskStore({ S: { id: 'T1', name: 'T' }, Child: { id: 'T2', name: 'Other' }, P: { id: 'T1', name: 'T' } });
  assert.equal(attachError('S', 'P', { sessions, taskStore: t }), null);
});

function ctx(sessions, overrides = {}) {
  const calls = { attach: [], reply: [], rebuild: 0 };
  return {
    calls,
    sessionManager: { attachSession: (sid, pid) => { calls.attach.push({ sid, pid }); return true; } },
    taskStore: taskStore(overrides.taskById || {}),
    graph: () => ({ sessions }),
    reply: (obj) => calls.reply.push(obj),
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('attachHandler: attaches and rebuilds when the guard passes', async () => {
  const c = ctx([{ sessionId: 'S1' }, { sessionId: 'S2' }]);
  await attachHandler.handler({ type: 'attach', sessionId: 'S1', parentSessionId: 'S2' }, c);
  assert.deepEqual(c.calls.attach, [{ sid: 'S1', pid: 'S2' }]);
  assert.equal(c.calls.rebuild, 1);
  assert.equal(c.calls.reply.length, 0);
});

test('attachHandler: replies with an error and never mutates when the guard fails', async () => {
  const c = ctx([{ sessionId: 'S1' }]);
  await attachHandler.handler({ type: 'attach', sessionId: 'S1', parentSessionId: 'S1' }, c);
  assert.equal(c.calls.attach.length, 0);
  assert.equal(c.calls.rebuild, 0);
  assert.equal(c.calls.reply[0].type, 'error');
  assert.match(c.calls.reply[0].message, /itself/);
});
