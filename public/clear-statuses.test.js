import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearableSessions } from './clear-statuses.js';

function ctx({ justFinished = [], unread = [], acked = [], phases = {} } = {}) {
  return {
    justFinished: new Set(justFinished),
    unread: new Set(unread),
    isAcknowledged: (s) => acked.includes(s.sessionId),
    phaseOf: (s) => phases[s.sessionId] ?? null,
  };
}

const ids = (list) => list.map((s) => s.sessionId);

test('clearableSessions: nothing flagged → empty', () => {
  const sessions = [{ sessionId: 'A', status: 'idle' }, { sessionId: 'B', status: 'working' }];
  assert.deepEqual(clearableSessions(sessions, ctx()), []);
});

test('clearableSessions: picks just-finished, unread, unacknowledged needs-you and awake snoozes', () => {
  const sessions = [
    { sessionId: 'JF', status: 'idle' },
    { sessionId: 'UR', status: 'idle' },
    { sessionId: 'NY', status: 'needs-you' },
    { sessionId: 'AW', status: 'idle' },
    { sessionId: 'QUIET', status: 'working' },
  ];
  const got = clearableSessions(sessions, ctx({ justFinished: ['JF'], unread: ['UR'], phases: { AW: 'awake' } }));
  assert.deepEqual(ids(got), ['JF', 'UR', 'NY', 'AW']);
});

test('clearableSessions: an acknowledged needs-you is already steady, not clearable', () => {
  const sessions = [{ sessionId: 'NY', status: 'needs-you' }];
  assert.deepEqual(clearableSessions(sessions, ctx({ acked: ['NY'] })), []);
});

test('clearableSessions: a still-sleeping snooze is left alone, even with a stale halo', () => {
  const sessions = [{ sessionId: 'Z', status: 'idle' }];
  assert.deepEqual(clearableSessions(sessions, ctx({ unread: ['Z'], phases: { Z: 'asleep' } })), []);
});

test('clearableSessions: covers nested children like any other session in the task', () => {
  const sessions = [
    { sessionId: 'ORCH', status: 'working' },
    { sessionId: 'C1', parentSession: 'ORCH', status: 'idle' },
    { sessionId: 'GC1', parentSession: 'C1', status: 'needs-you' },
  ];
  assert.deepEqual(ids(clearableSessions(sessions, ctx({ justFinished: ['C1'] }))), ['C1', 'GC1']);
});
