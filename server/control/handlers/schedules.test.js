import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleCreateHandler,
  scheduleUpdateHandler,
  scheduleDeleteHandler,
  scheduleToggleHandler,
  scheduleRunNowHandler,
} from './schedules.js';

function ctx(overrides = {}) {
  const calls = { create: [], update: [], delete: [], setEnabled: [], runSchedule: [], rebuild: 0 };
  return {
    calls,
    scheduleStore: {
      create: (payload, now) => calls.create.push({ payload, now }),
      update: (id, patch, now) => calls.update.push({ id, patch, now }),
      delete: (id) => calls.delete.push(id),
      setEnabled: (id, enabled, now) => calls.setEnabled.push({ id, enabled, now }),
    },
    runSchedule: (id, opts) => { calls.runSchedule.push({ id, opts }); },
    rebuild: async () => { calls.rebuild += 1; },
    ...overrides,
  };
}

test('schedule-create forwards name/when/action (+ legacy dispatch) + a clock, then rebuilds', async () => {
  const c = ctx();
  const when = { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' };
  const action = { kind: 'dispatch', dispatch: { cwd: '/r' } };
  await scheduleCreateHandler.handler({ type: 'schedule-create', name: 'D', when, action }, c);
  assert.equal(c.calls.create.length, 1);
  assert.deepEqual(c.calls.create[0].payload, { name: 'D', when, action, dispatch: undefined });
  assert.equal(typeof c.calls.create[0].now, 'number');
  assert.equal(c.calls.rebuild, 1);
});

test('schedule-update forwards id + patch (defaulting patch to {}), then rebuilds', async () => {
  const c = ctx();
  await scheduleUpdateHandler.handler({ type: 'schedule-update', id: 'sch_1', patch: { name: 'x' } }, c);
  assert.deepEqual(c.calls.update[0].patch, { name: 'x' });
  assert.equal(c.calls.update[0].id, 'sch_1');
  await scheduleUpdateHandler.handler({ type: 'schedule-update', id: 'sch_2' }, c);
  assert.deepEqual(c.calls.update[1].patch, {});
  assert.equal(c.calls.rebuild, 2);
});

test('schedule-delete removes and rebuilds', async () => {
  const c = ctx();
  await scheduleDeleteHandler.handler({ type: 'schedule-delete', id: 'sch_1' }, c);
  assert.deepEqual(c.calls.delete, ['sch_1']);
  assert.equal(c.calls.rebuild, 1);
});

test('schedule-toggle coerces enabled to a boolean and rebuilds', async () => {
  const c = ctx();
  await scheduleToggleHandler.handler({ type: 'schedule-toggle', id: 'sch_1', enabled: 1 }, c);
  assert.deepEqual(c.calls.setEnabled[0], { id: 'sch_1', enabled: true, now: c.calls.setEnabled[0].now });
  assert.equal(typeof c.calls.setEnabled[0].now, 'number');
  assert.equal(c.calls.rebuild, 1);
});

test('schedule-run-now invokes the injected runSchedule with manual:true (no extra rebuild)', async () => {
  const c = ctx();
  await scheduleRunNowHandler.handler({ type: 'schedule-run-now', id: 'sch_1' }, c);
  assert.deepEqual(c.calls.runSchedule, [{ id: 'sch_1', opts: { manual: true } }]);
  // run-now rebuilds inside runSchedule, so the handler doesn't call ctx.rebuild itself.
  assert.equal(c.calls.rebuild, 0);
});
