import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleSessionTool } from './schedule-session.js';

// Deps double. The fake ScheduleStore records the create payload and echoes back a
// created-shape object so the tool can build its structured result; taskStore.taskFor
// resolves the caller's current task (for the dispatch default).
function deps(created = {}) {
  const calls = { create: [], rebuild: 0 };
  return {
    calls,
    scheduleStore: {
      create: (payload, now) => {
        calls.create.push({ payload, now });
        const action = payload.action;
        return {
          id: 'sch_new', name: payload.name || 'Untitled schedule', enabled: true,
          when: payload.when, action, nextRunAt: '2026-06-25T15:00:00.000Z',
          ...created,
        };
      },
    },
    taskStore: { taskFor: (id) => (id === 'CARD_T' ? { id: 'T9' } : null) },
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('infers dispatch from an `intent`, defaults the task to the caller, builds a once `when`', async () => {
  const d = deps();
  const out = await scheduleSessionTool.handler(
    { deps: d, caller: 'CARD_T' },
    { at: '2026-06-25T15:00:00Z', intent: 'do the thing', model: 'opus' });
  const { payload } = d.calls.create[0];
  assert.deepEqual(payload.when, { kind: 'once', runAt: '2026-06-25T15:00:00.000Z' });
  assert.equal(payload.action.kind, 'dispatch');
  assert.equal(payload.action.dispatch.intent, 'do the thing');
  assert.equal(payload.action.dispatch.taskId, 'T9'); // inherited from caller
  assert.equal(payload.action.dispatch.model, 'opus');
  assert.equal(d.calls.rebuild, 1);
  assert.equal(out.structuredContent.kind, 'dispatch');
  assert.equal(out.structuredContent.id, 'sch_new');
});

test('infers session (no intent), defaults the target to the caller, carries a cron + tz', async () => {
  const d = deps();
  const out = await scheduleSessionTool.handler(
    { deps: d, caller: 'CARD_T' },
    { cron: '0 9 * * 1-5', tz: 'Europe/London', message: 'check CI' });
  const { payload } = d.calls.create[0];
  assert.deepEqual(payload.when, { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/London' });
  assert.deepEqual(payload.action, { kind: 'session', sessionId: 'CARD_T', message: 'check CI' });
  assert.equal(out.structuredContent.target, 'CARD_T');
});

test('session kind targets another session with an explicit message', async () => {
  const d = deps();
  const ok = await scheduleSessionTool.handler(
    { deps: d, caller: 'CARD_T' },
    { at: '2026-06-25T15:00:00Z', kind: 'session', target_session: 'CARD_X', message: 'standup time' });
  assert.deepEqual(d.calls.create[0].payload.action, { kind: 'session', sessionId: 'CARD_X', message: 'standup time' });
  assert.equal(ok.isError, undefined);
});

test('session kind with no message creates a message-less action (not an error)', async () => {
  const d = deps();
  const out = await scheduleSessionTool.handler(
    { deps: d, caller: 'CARD_T' },
    { at: '2026-06-25T15:00:00Z', kind: 'session', target_session: 'CARD_X' });
  assert.deepEqual(d.calls.create[0].payload.action, { kind: 'session', sessionId: 'CARD_X', message: '' });
  assert.equal(out.isError, undefined);
});

test('rejects missing/ambiguous when, a bad date, dispatch with no intent, and a target-less session', async () => {
  const noWhen = await scheduleSessionTool.handler({ deps: deps(), caller: 'C' }, { intent: 'x' });
  assert.equal(noWhen.isError, true);
  assert.match(noWhen.content[0].text, /needs a time/);

  const both = await scheduleSessionTool.handler({ deps: deps(), caller: 'C' }, { at: '2026-06-25T15:00:00Z', cron: '0 9 * * *', intent: 'x' });
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /not both/);

  const badAt = await scheduleSessionTool.handler({ deps: deps(), caller: 'C' }, { at: 'whenever', intent: 'x' });
  assert.equal(badAt.isError, true);

  const noIntent = await scheduleSessionTool.handler({ deps: deps(), caller: 'C' }, { at: '2026-06-25T15:00:00Z', kind: 'dispatch' });
  assert.equal(noIntent.isError, true);
  assert.match(noIntent.content[0].text, /needs an `intent`/);

  const noTarget = await scheduleSessionTool.handler({ deps: deps(), caller: null }, { at: '2026-06-25T15:00:00Z', kind: 'session' });
  assert.equal(noTarget.isError, true);
  assert.match(noTarget.content[0].text, /No target session/);
});

test('surfaces a store validation error as an error result (e.g. a bad cron)', async () => {
  const d = deps();
  d.scheduleStore.create = () => { throw new Error('Invalid cron expression: garbage'); };
  const out = await scheduleSessionTool.handler({ deps: d, caller: 'C' }, { cron: 'garbage', message: 'x', kind: 'session', target_session: 'C2' });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Invalid cron/);
});
