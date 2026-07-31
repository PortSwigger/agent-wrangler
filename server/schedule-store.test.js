import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduleStore, validateSchedule } from './schedule-store.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-schedules-')), 'schedules.json');
}

// Fixed clocks (UTC, machine-independent — cron `when`s carry tz).
const at = (...args) => Date.UTC(...args);
const NOW = at(2026, 5, 24, 6, 0, 0); // Wed 06:00 UTC
const DAILY = { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' };
const ONCE = { kind: 'once', runAt: '2026-06-24T15:00:00.000Z' };

test('create: assigns id/createdAt, seeds nextRunAt, persists, reloads', () => {
  const file = tmpFile();
  const store = new ScheduleStore(file);
  const s = store.create({ name: 'Daily', when: DAILY, dispatch: { cwd: '/repo', intent: 'go' } }, NOW);
  assert.match(s.id, /^sch_/);
  assert.equal(s.enabled, true);
  assert.equal(s.lastRunAt, null);
  assert.equal(s.lastSessionId, null);
  assert.equal(s.missed, false);
  assert.equal(s.createdAt, new Date(NOW).toISOString());
  assert.equal(s.nextRunAt, new Date(at(2026, 5, 24, 9, 0, 0)).toISOString());

  const reloaded = new ScheduleStore(file);
  const snap = reloaded.snapshot();
  assert.equal(snap.schedules.length, 1);
  assert.equal(snap.schedules[0].name, 'Daily');
});

test('create: blank name falls back to a default', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: '   ', when: ONCE, dispatch: {} }, NOW);
  assert.equal(s.name, 'Untitled schedule');
});

test('snapshot is a deep copy — mutating it cannot corrupt the store', () => {
  const store = new ScheduleStore(tmpFile());
  store.create({ name: 'A', when: DAILY, dispatch: { cwd: '/r' } }, NOW);
  const snap = store.snapshot();
  snap.schedules[0].name = 'mutated';
  snap.schedules[0].action.dispatch.cwd = '/hacked';
  assert.equal(store.snapshot().schedules[0].name, 'A');
  assert.equal(store.snapshot().schedules[0].action.dispatch.cwd, '/r');
});

test('due: filters by enabled and by nextRunAt <= now', () => {
  const store = new ScheduleStore(tmpFile());
  const one = store.create({ name: 'one', when: ONCE, dispatch: {} }, NOW);   // nextRunAt 15:00
  const daily = store.create({ name: 'daily', when: DAILY, dispatch: {} }, NOW); // nextRunAt today 09:00
  // 07:00: neither slot reached yet.
  assert.deepEqual(store.due(at(2026, 5, 24, 7, 0, 0)).map((s) => s.name), []);
  // 10:00: the daily slot has passed, the one-off (15:00) hasn't.
  assert.deepEqual(store.due(at(2026, 5, 24, 10, 0, 0)).map((s) => s.name), ['daily']);
  // 16:00: both due — then disabling the daily drops it from the due set.
  assert.deepEqual(store.due(at(2026, 5, 24, 16, 0, 0)).map((s) => s.name).sort(), ['daily', 'one']);
  store.setEnabled(daily.id, false, at(2026, 5, 24, 16, 0, 0));
  assert.deepEqual(store.due(at(2026, 5, 24, 16, 0, 0)).map((s) => s.name), ['one']);
  assert.ok(one.id && daily.id);
});

test('markFired cron: advances nextRunAt strictly past now, stays enabled', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: 'Daily', when: DAILY, dispatch: {} }, NOW);
  // Fire at 09:00:05 (just after the slot).
  const firedNow = at(2026, 5, 24, 9, 0, 5);
  const after = store.markFired(s.id, { at: new Date(firedNow).toISOString(), sessionId: 'SID1' }, firedNow);
  assert.equal(after.enabled, true);
  assert.equal(after.lastSessionId, 'SID1');
  assert.equal(after.lastRunAt, new Date(firedNow).toISOString());
  // Next occurrence is tomorrow 09:00 — never re-fires the slot it just fired.
  assert.equal(after.nextRunAt, new Date(at(2026, 5, 25, 9, 0, 0)).toISOString());
});

test('markFired once: disables and clears nextRunAt', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: 'One', when: ONCE, dispatch: {} }, NOW);
  const after = store.markFired(s.id, { at: '2026-06-24T15:00:01.000Z', sessionId: 'SID2' }, at(2026, 5, 24, 15, 0, 1));
  assert.equal(after.enabled, false);
  assert.equal(after.nextRunAt, null);
  assert.equal(after.lastSessionId, 'SID2');
});

test('markFired advance:false (run-now) records the run but leaves nextRunAt/enabled alone', () => {
  const store = new ScheduleStore(tmpFile());
  const daily = store.create({ name: 'Daily', when: DAILY, dispatch: {} }, NOW);
  const onceSch = store.create({ name: 'One', when: ONCE, dispatch: {} }, NOW);
  const runNow = at(2026, 5, 24, 12, 0, 0);

  const d = store.markFired(daily.id, { at: new Date(runNow).toISOString(), sessionId: 'X' }, runNow, { advance: false });
  assert.equal(d.lastSessionId, 'X');
  assert.equal(d.nextRunAt, daily.nextRunAt); // unchanged

  const o = store.markFired(onceSch.id, { at: new Date(runNow).toISOString(), sessionId: 'Y' }, runNow, { advance: false });
  assert.equal(o.enabled, true);          // not disabled by a run-now
  assert.equal(o.nextRunAt, onceSch.nextRunAt);
});

test('markMissed: disables, flags missed, clears nextRunAt', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: 'One', when: ONCE, dispatch: {} }, NOW);
  const after = store.markMissed(s.id);
  assert.equal(after.enabled, false);
  assert.equal(after.missed, true);
  assert.equal(after.nextRunAt, null);
});

test('setEnabled re-enable recomputes nextRunAt from now (no firing for the slept gap)', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: 'Daily', when: DAILY, dispatch: {} }, NOW);
  store.setEnabled(s.id, false, NOW);
  // Re-enable a week later, in the afternoon → next slot is tomorrow 09:00, not a backlog.
  const later = at(2026, 7, 1, 14, 0, 0);
  const after = store.setEnabled(s.id, true, later);
  assert.equal(after.enabled, true);
  assert.equal(after.nextRunAt, new Date(at(2026, 7, 2, 9, 0, 0)).toISOString());
});

test('update: changing when recomputes nextRunAt and clears missed', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: 'One', when: ONCE, dispatch: {} }, NOW);
  store.markMissed(s.id);
  const after = store.update(s.id, { when: DAILY }, NOW);
  assert.equal(after.missed, false);
  assert.equal(after.nextRunAt, new Date(at(2026, 5, 24, 9, 0, 0)).toISOString());
  assert.equal(after.when.kind, 'cron');
});

test('update: changing only the name leaves when/nextRunAt untouched', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: 'Daily', when: DAILY, dispatch: {} }, NOW);
  const after = store.update(s.id, { name: 'Renamed' }, at(2030, 0, 1));
  assert.equal(after.name, 'Renamed');
  assert.equal(after.nextRunAt, s.nextRunAt); // not recomputed
});

test('delete: removes and persists; returns false for unknown', () => {
  const file = tmpFile();
  const store = new ScheduleStore(file);
  const s = store.create({ name: 'A', when: DAILY, dispatch: {} }, NOW);
  assert.equal(store.delete('sch_nope'), false);
  assert.equal(store.delete(s.id), true);
  assert.equal(new ScheduleStore(file).snapshot().schedules.length, 0);
});

test('validateSchedule: rejects a bad when', () => {
  assert.throws(() => validateSchedule({ kind: 'weekly' }, {}), /Unknown schedule kind/);
  assert.throws(() => validateSchedule({ kind: 'once', runAt: 'nope' }, {}), /valid date/);
  assert.throws(() => validateSchedule({ kind: 'cron', cron: 'garbage' }, {}), /Invalid cron/);
  assert.throws(() => validateSchedule(null, {}), /needs a "when"/);
});

test('validateSchedule: recurring + worktree forces worktreeAuto (unless workflow)', () => {
  // A bare dispatch bag (no kind) is normalised to a dispatch action.
  const { action: a } = validateSchedule(DAILY, { worktree: true });
  assert.equal(a.kind, 'dispatch');
  assert.equal(a.dispatch.worktreeAuto, true);
  // workflow already forces auto inside runDispatch → left untouched here.
  const { action: b } = validateSchedule(DAILY, { worktree: true, workflow: true });
  assert.equal(b.dispatch.worktreeAuto, undefined);
  // A one-off worktree is fine on a fixed branch (it only fires once) → not forced.
  const { action: c } = validateSchedule(ONCE, { worktree: true });
  assert.equal(c.dispatch.worktreeAuto, undefined);
});

test('create persists the forced worktreeAuto for a recurring worktree schedule', () => {
  const store = new ScheduleStore(tmpFile());
  const s = store.create({ name: 'wt', when: DAILY, dispatch: { worktree: true, cwd: '/r' } }, NOW);
  assert.equal(s.action.dispatch.worktreeAuto, true);
});

test('validateSchedule: a session action normalises + requires a target (message optional)', () => {
  const { action: s } = validateSchedule(DAILY, { kind: 'session', sessionId: ' sid ', message: ' hi ' });
  assert.deepEqual(s, { kind: 'session', sessionId: 'sid', message: 'hi' });
  // The message is optional — a no-message session action is valid (a live no-op or a plain resume).
  const { action: s2 } = validateSchedule(ONCE, { kind: 'session', sessionId: 'sid' });
  assert.deepEqual(s2, { kind: 'session', sessionId: 'sid', message: '' });
  // Missing target is rejected; an unknown kind too.
  assert.throws(() => validateSchedule(ONCE, { kind: 'session', sessionId: '  ' }), /needs a target/);
  assert.throws(() => validateSchedule(ONCE, { kind: 'frobnicate' }), /Unknown schedule action/);
});

test('create + reload: a session action round-trips, no worktree rule applied', () => {
  const file = tmpFile();
  const s = new ScheduleStore(file).create(
    { name: 'wake', when: DAILY, action: { kind: 'session', sessionId: 'card_1', message: 'check CI' } }, NOW);
  assert.equal(s.action.kind, 'session');
  assert.equal(s.action.sessionId, 'card_1');
  const reloaded = new ScheduleStore(file).snapshot().schedules[0];
  assert.deepEqual(reloaded.action, { kind: 'session', sessionId: 'card_1', message: 'check CI' });
});

test('_load migrates a legacy top-level dispatch into a dispatch action', () => {
  const file = tmpFile();
  // Hand-write the pre-action on-disk shape.
  fs.writeFileSync(file, JSON.stringify({ schedules: [{
    id: 'sch_old', name: 'legacy', enabled: true, when: DAILY,
    dispatch: { cwd: '/r', intent: 'go' }, createdAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: null, lastSessionId: null, nextRunAt: null, missed: false,
  }] }));
  const loaded = new ScheduleStore(file).snapshot().schedules[0];
  assert.equal(loaded.dispatch, undefined);
  assert.deepEqual(loaded.action, { kind: 'dispatch', dispatch: { cwd: '/r', intent: 'go' } });
});
