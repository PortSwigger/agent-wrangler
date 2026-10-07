import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateService, canAutoApply, UpdateBusyError, updateSupport, installDriftStatus } from './update-service.js';

const behind = { head: 'h0', remote: 'r1', behind: 2, commits: [], blocked: null };

function service(overrides = {}) {
  const events = { statuses: [], applied: [], markers: [], logs: [] };
  const svc = createUpdateService({
    check: async () => behind,
    apply: async ({ beforeMerge }) => { beforeMerge(behind); return { ...behind, head: 'r1', updated: true }; },
    writeMarker: (m) => events.markers.push(m),
    support: { available: true, canApply: true, reason: null },
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

test('a merge that fails after the marker is written clears it again', async () => {
  let cleared = 0;
  const { svc, events } = service({
    apply: async ({ beforeMerge }) => { beforeMerge(behind); throw new Error('untracked file would be overwritten'); },
    clearMarker: () => { cleared += 1; },
  });
  await assert.rejects(() => svc.apply(), /untracked file/);
  assert.equal(events.markers.length, 1);
  assert.equal(cleared, 1);
  assert.equal(events.applied.length, 0);
});

test('a refusal before the merge leaves any existing marker alone', async () => {
  let cleared = 0;
  const { svc } = service({
    apply: async () => { throw new Error('dirty'); },
    clearMarker: () => { cleared += 1; },
  });
  await assert.rejects(() => svc.apply(), /dirty/);
  assert.equal(cleared, 0);
});

test('apply refuses without the capability, before touching git or the marker', async () => {
  let applied = 0;
  const support = updateSupport({ checkout: true, supervised: true, gitUpdates: false });
  const { svc, events } = service({ support, apply: async () => { applied += 1; } });
  await assert.rejects(() => svc.apply(), /not started by the checkout service/);
  assert.equal(applied, 0);
  assert.equal(events.markers.length, 0);
});

// Restart support and update capability are separate: a Homebrew service is
// supervised (restartable) but its start path has no rollback or dependency
// sync; a bare launcher may be supervised by hand; a pane-started dev instance
// may still carry the board's signals in a pane that predates the env rule.
for (const [label, input, want] of [
  ['checkout service', { checkout: true, supervised: true, gitUpdates: true }, { available: true, canApply: true }],
  ['supervised bare launcher', { checkout: true, supervised: true, gitUpdates: false }, { available: true, canApply: false }],
  ['unsupervised checkout (npm start)', { checkout: true, supervised: false, gitUpdates: false }, { available: true, canApply: false }],
  ['capability without a supervisor', { checkout: true, supervised: false, gitUpdates: true }, { available: true, canApply: false }],
  ['dev instance with inherited signals', { checkout: true, supervised: true, gitUpdates: true, dev: true }, { available: true, canApply: false }],
  ['not a checkout', { checkout: false, supervised: true, gitUpdates: true }, { available: false, canApply: false }],
  ['Homebrew-managed, even in a checkout', { installManager: 'homebrew', checkout: true, supervised: true, gitUpdates: true }, { available: false, canApply: false }],
]) {
  test(`update support: ${label}`, () => {
    const got = updateSupport(input);
    assert.equal(got.available, want.available);
    assert.equal(got.canApply, want.canApply);
    assert.equal(Boolean(got.reason), !want.canApply, 'a reason whenever it cannot apply');
  });
}

test('a managed install says how it is updated instead', () => {
  assert.match(updateSupport({ installManager: 'homebrew' }).reason, /brew upgrade agent-wrangler/);
  assert.match(updateSupport({ installManager: 'nix' }).reason, /managed by nix/);
});

test('an unavailable updater never checks, even in auto mode, and logs nothing', async () => {
  let checks = 0;
  const support = updateSupport({ installManager: 'homebrew', supervised: true });
  const { svc, events } = service({ support, check: async () => { checks += 1; return behind; } });
  assert.equal(await svc.tick(), null);
  assert.equal(checks, 0);
  assert.deepEqual(events.logs, []);
  assert.deepEqual(events.statuses, []);
  assert.match(svc.unavailable(), /Homebrew/);
});

test('an unavailable updater refuses a direct check or apply request', async () => {
  let calls = 0;
  const support = updateSupport({ checkout: false, supervised: true, gitUpdates: true });
  const { svc, events } = service({ support, check: async () => { calls += 1; return behind; }, apply: async () => { calls += 1; } });
  await assert.rejects(() => svc.check(), /not a Git checkout/);
  await assert.rejects(() => svc.apply(), /not a Git checkout/);
  assert.equal(calls, 0);
  assert.equal(events.markers.length, 0);
});

test('an available updater reports no unavailability', () => {
  assert.equal(service().svc.unavailable(), null);
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

test('drift reaches the board with the running version and how to restart by hand', () => {
  const drift = { installRoot: '/opt/homebrew/opt/agent-wrangler', target: '/opt/homebrew/Cellar/agent-wrangler/0.2.0', version: '0.2.0' };
  assert.equal(installDriftStatus(null, { manager: 'homebrew', runningVersion: '0.1.0' }), null);
  const brew = installDriftStatus(drift, { manager: 'homebrew', runningVersion: '0.1.0' });
  assert.deepEqual({ ...brew, restartHint: undefined }, { ...drift, runningVersion: '0.1.0', restartHint: undefined });
  // Matches managedReason's wording for the same install.
  assert.match(brew.restartHint, /`brew services restart agent-wrangler`/);
  assert.match(updateSupport({ installManager: 'homebrew' }).reason, /`brew services restart agent-wrangler`/);
  assert.equal(installDriftStatus(drift, { manager: null }).restartHint, 'Stop and start it the way you launched it.');
});
