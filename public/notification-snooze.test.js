import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SNOOZE_MINUTES, emptySnoozes, snoozeKeysFor, parseSnoozes, snoozeSource, snoozeAll,
  cancelSource, cancelAll, isSnoozed, activeSnoozes, remainingLabel, createSnoozeStore,
  sessionSource, prSource, snoozeToastActions,
} from './notification-snooze.js';

const MIN = 60e3;
const T0 = 1_700_000_000_000;

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

test('keys: session events key on the session, PR events on the PR and their session', () => {
  assert.deepEqual(snoozeKeysFor('session', 's1'), ['session:s1']);
  assert.deepEqual(snoozeKeysFor('session', 's1', 'https://github.com/a/b/pull/1'), ['session:s1', 'pr:https://github.com/a/b/pull/1']);
  assert.deepEqual(snoozeKeysFor('task', 't1', 'https://github.com/a/b/pull/1'), ['pr:https://github.com/a/b/pull/1']);
  assert.deepEqual(snoozeKeysFor('task', 't1'), []);
});

test('a source snooze silences only that source, until it expires', () => {
  const s = snoozeSource(emptySnoozes(), sessionSource('s1'), 'Build', 10, T0);
  assert.equal(isSnoozed(s, ['session:s1'], T0 + 9 * MIN), true);
  assert.equal(isSnoozed(s, ['session:s2'], T0 + 9 * MIN), false);
  assert.equal(isSnoozed(s, ['session:s1'], T0 + 10 * MIN), false);
});

test('snooze all silences every source, including keyless events', () => {
  const s = snoozeAll(emptySnoozes(), 5, T0);
  assert.equal(isSnoozed(s, [], T0 + 4 * MIN), true);
  assert.equal(isSnoozed(s, ['pr:x'], T0 + 4 * MIN), true);
  assert.equal(isSnoozed(s, [], T0 + 5 * MIN), false);
});

test('durations outside 5/10/30 fall back to the 10 minute default', () => {
  assert.equal(DEFAULT_SNOOZE_MINUTES, 10);
  assert.equal(snoozeAll(emptySnoozes(), 7, T0).all, T0 + 10 * MIN);
  assert.equal(snoozeAll(emptySnoozes(), 30, T0).all, T0 + 30 * MIN);
});

test('cancel one leaves the others; cancel all leaves source snoozes', () => {
  let s = snoozeSource(emptySnoozes(), 'session:a', 'A', 10, T0);
  s = snoozeSource(s, prSource('u'), 'PR #1', 10, T0);
  s = snoozeAll(s, 10, T0);
  s = cancelSource(s, 'session:a', T0);
  assert.equal(isSnoozed(s, ['session:a'], T0), true, 'still covered by snooze all');
  s = cancelAll(s, T0);
  assert.equal(isSnoozed(s, ['session:a'], T0), false);
  assert.equal(isSnoozed(s, ['pr:u'], T0), true);
});

test('active snoozes list "all" first, then soonest-expiring sources', () => {
  let s = snoozeSource(emptySnoozes(), 'session:a', 'A', 30, T0);
  s = snoozeSource(s, 'session:b', 'B', 5, T0);
  s = snoozeAll(s, 10, T0);
  assert.deepEqual(activeSnoozes(s, T0).map((x) => x.key), ['all', 'session:b', 'session:a']);
  assert.deepEqual(activeSnoozes(s, T0 + 11 * MIN).map((x) => x.key), ['session:a']);
});

test('parse drops expired entries and survives corrupt input', () => {
  const raw = JSON.stringify({ all: T0 - 1, sources: { 'session:a': { until: T0 + MIN, label: 'A' }, 'session:b': { until: T0 - 1, label: 'B' } }, minutes: 30 });
  assert.deepEqual(parseSnoozes(raw, T0), { all: null, sources: { 'session:a': { until: T0 + MIN, label: 'A' } }, minutes: 30 });
  assert.deepEqual(parseSnoozes('{not json', T0), emptySnoozes());
  assert.deepEqual(parseSnoozes('null', T0), emptySnoozes());
  assert.deepEqual(parseSnoozes(null, T0), emptySnoozes());
});

test('remaining label rounds up to whole minutes', () => {
  assert.equal(remainingLabel(T0 + 10 * MIN, T0), '10m');
  assert.equal(remainingLabel(T0 + 9 * MIN + 1, T0), '10m');
  assert.equal(remainingLabel(T0 + 30e3, T0), '<1m');
  assert.equal(remainingLabel(T0, T0), '0m');
});

test('store persists snoozes and the chosen length across reloads', () => {
  let now = T0;
  const storage = memoryStorage();
  const a = createSnoozeStore({ storage, now: () => now });
  a.setMinutes(30);
  a.snoozeSource('session:s1', 'Build');
  const b = createSnoozeStore({ storage, now: () => now });
  assert.equal(b.minutes(), 30);
  assert.equal(b.isSnoozed(['session:s1']), true);
  now = T0 + 30 * MIN;
  assert.equal(b.isSnoozed(['session:s1']), false);
  assert.deepEqual(b.active(), []);
});

test('store works when storage throws', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const store = createSnoozeStore({ storage, now: () => T0 });
  store.snoozeAll();
  assert.equal(store.isSnoozed([]), true);
  assert.equal(createSnoozeStore({ storage: null, now: () => T0 }).isSnoozed([]), false);
});

test('store notifies subscribers and reloads from another tab\'s write', () => {
  const storage = memoryStorage();
  const store = createSnoozeStore({ storage, now: () => T0 });
  const seen = [];
  store.subscribe((s) => seen.push(s.all));
  createSnoozeStore({ storage, now: () => T0 }).snoozeAll(5);
  assert.equal(store.isSnoozed([]), false);
  store.reload();
  assert.equal(store.isSnoozed([]), true);
  assert.deepEqual(seen, [T0 + 5 * MIN]);
});

test('toast actions snooze the source or everything for the chosen length', () => {
  const store = createSnoozeStore({ storage: memoryStorage(), now: () => T0 });
  store.setMinutes(5);
  const [one, all] = snoozeToastActions(store, 'pr:u', 'PR #1');
  assert.equal(one.label, 'Snooze 5m');
  assert.equal(all.label, 'Snooze all');
  one.onClick();
  assert.deepEqual(store.active().map((x) => [x.key, x.label, x.until]), [['pr:u', 'PR #1', T0 + 5 * MIN]]);
  all.onClick();
  assert.equal(store.active()[0].key, 'all');
});

test('an event with no source offers only Snooze all', () => {
  const store = createSnoozeStore({ storage: memoryStorage(), now: () => T0 });
  assert.deepEqual(snoozeToastActions(store, null, 'x').map((a) => a.label), ['Snooze all']);
});
