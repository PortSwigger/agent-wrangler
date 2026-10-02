import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateService, canAutoApply, UpdateBusyError } from './update-service.js';

const behind = { head: 'h0', remote: 'r1', behind: 2, commits: [], blocked: null };

function service(overrides = {}) {
  const events = { statuses: [], applied: [], markers: [], logs: [] };
  const svc = createUpdateService({
    check: async () => behind,
    apply: async ({ beforeMerge }) => { beforeMerge(behind); return { ...behind, head: 'r1', updated: true }; },
    writeMarker: (m) => events.markers.push(m),
    supervised: () => true,
    mode: () => 'auto',
    onStatus: (s) => events.statuses.push(s),
    onApplied: (r) => events.applied.push(r),
    log: (l) => events.logs.push(l),
    ...overrides,
  });
  return { svc, events };
}

test('auto-apply needs a clean fast-forward, a supervisor, and a target that has not already rolled back', () => {
  const ok = { ...behind, canApply: true };
  assert.equal(canAutoApply(ok, null), true);
  assert.equal(canAutoApply({ ...ok, behind: 0 }, null), false);
  assert.equal(canAutoApply({ ...ok, blocked: 'dirty' }, null), false);
  assert.equal(canAutoApply({ ...ok, canApply: false }, null), false);
  assert.equal(canAutoApply(ok, { target: 'r1' }), false);
  assert.equal(canAutoApply(ok, { target: 'older' }), true);
});

test('a check publishes the status with what the board needs to act on it', async () => {
  const { svc, events } = service({ rolledBack: { target: 'x' } });
  const status = await svc.check();
  assert.equal(status.canApply, true);
  assert.deepEqual(status.rolledBack, { target: 'x' });
  assert.equal(typeof status.checkedAt, 'number');
  assert.equal(events.statuses.length, 1);
  assert.equal(svc.latest(), status);
});

test('apply writes the rollback marker before merging, then hands off to restart', async () => {
  const { svc, events } = service();
  await svc.apply();
  assert.deepEqual(events.markers, [{ previous: 'h0', target: 'r1' }]);
  assert.equal(events.applied.length, 1);
});

test('apply refuses without a supervisor', async () => {
  const { svc, events } = service({ supervised: () => false });
  await assert.rejects(() => svc.apply(), /not started by a supervisor/);
  assert.equal(events.markers.length, 0);
});

test('a second request while one runs is refused', async () => {
  let release;
  const { svc } = service({ check: () => new Promise((r) => { release = () => r(behind); }) });
  const first = svc.check();
  await assert.rejects(() => svc.check(), UpdateBusyError);
  release();
  await first;
});

test('a tick in notify mode checks but never applies', async () => {
  const { svc, events } = service({ mode: () => 'notify' });
  await svc.tick();
  assert.equal(events.statuses.length, 1);
  assert.equal(events.applied.length, 0);
});

test('a tick in off mode does not even check', async () => {
  const { svc, events } = service({ mode: () => 'off' });
  await svc.tick();
  assert.equal(events.statuses.length, 0);
});

test('a tick in auto mode applies only when the wrangler is quiet', async () => {
  const busy = service({ isQuiet: () => false });
  await busy.svc.tick();
  assert.equal(busy.events.applied.length, 0);
  const quiet = service();
  await quiet.svc.tick();
  assert.equal(quiet.events.applied.length, 1);
  assert.match(quiet.events.logs[0], /auto-updated to r1/);
});

test('a failing check in a tick is logged, not thrown', async () => {
  const { svc, events } = service({ check: async () => { throw new Error('offline'); } });
  assert.equal(await svc.tick(), null);
  assert.match(events.logs[0], /offline/);
});
