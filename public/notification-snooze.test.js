import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySnoozes, snoozeMinutes, notificationKey, parseSnoozes, holdNotification, supersede, snoozeAll,
  takeDue, nextWake, stillTrue, createSnoozeStore, createPopupTracker,
} from './notification-snooze.js';

const MIN = 60e3;
const T0 = 1_700_000_000_000;
const needsYou = (id) => ({ type: 'notify', session: { sessionId: id, label: id } });
const dirty = (url) => ({ type: 'pr-dirty', scope: 'session', sessionId: 's1', url, number: 1 });

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

test('snooze length is 5, 10 or 30 minutes, defaulting to 10', () => {
  assert.equal(snoozeMinutes('5'), 5);
  assert.equal(snoozeMinutes('30'), 30);
  assert.equal(snoozeMinutes('7'), 10);
  assert.equal(snoozeMinutes(undefined), 10);
});

test('a notification is keyed by its session or its PR', () => {
  assert.equal(notificationKey(needsYou('s1')), 'session:s1');
  assert.equal(notificationKey(dirty('u')), 'pr:u');
  assert.equal(notificationKey({ type: 'pr-merge', sessionId: 's1' }), 'pr:s1');
});

test('a held notification comes back once its time is up', () => {
  const s = holdNotification(emptySnoozes(), needsYou('s1'), T0 + 10 * MIN);
  assert.deepEqual(takeDue(s, T0 + 9 * MIN).due, []);
  const { state, due } = takeDue(s, T0 + 10 * MIN);
  assert.deepEqual(due, [needsYou('s1')]);
  assert.deepEqual(state.held, []);
  assert.equal(nextWake(s, T0), T0 + 10 * MIN);
  assert.equal(nextWake(state, T0), null);
});

test('a newer notification about the same session or PR replaces the held copy', () => {
  let s = holdNotification(emptySnoozes(), dirty('u'), T0 + MIN);
  s = holdNotification(s, needsYou('s1'), T0 + MIN);
  s = supersede(s, { type: 'pr-checks', url: 'u', status: 'failing' });
  assert.deepEqual(s.held.map((e) => e.key), ['session:s1']);
  s = holdNotification(s, { ...needsYou('s1'), session: { sessionId: 's1', label: 'newer' } }, T0 + 2 * MIN);
  assert.equal(s.held.length, 1);
  assert.equal(s.held[0].msg.session.label, 'newer');
});

test('snooze all holds what was on screen, and everything, until it ends', () => {
  let s = holdNotification(emptySnoozes(), needsYou('early'), T0 + MIN);
  s = snoozeAll(s, [dirty('u')], 10, T0);
  assert.equal(s.all, T0 + 10 * MIN);
  assert.deepEqual(takeDue(s, T0 + 5 * MIN).due, [], 'nothing comes back during snooze all, even an earlier single snooze');
  assert.equal(nextWake(s, T0), T0 + 10 * MIN);
  const { state, due } = takeDue(s, T0 + 10 * MIN);
  assert.deepEqual(due.map(notificationKey).sort(), ['pr:u', 'session:early']);
  assert.equal(state.all, null);
});

test('a held notification comes back only while it is still true', () => {
  const sessions = { s1: { status: 'needs-you' }, s2: { status: 'idle' } };
  const links = { a: { checkStatus: 'failing', dirty: true, unresolvedCount: 2 }, b: { checkStatus: 'passing', dirty: false, unresolvedCount: 0 } };
  const lookup = { session: (id) => sessions[id], prLink: (url) => links[url] };
  assert.equal(stillTrue(needsYou('s1'), lookup), true);
  assert.equal(stillTrue(needsYou('s2'), lookup), false, 'answered since');
  assert.equal(stillTrue(needsYou('gone'), lookup), false, 'archived since');
  assert.equal(stillTrue({ type: 'pr-checks', url: 'a', status: 'failing' }, lookup), true);
  assert.equal(stillTrue({ type: 'pr-checks', url: 'b', status: 'failing' }, lookup), false);
  assert.equal(stillTrue(dirty('a'), lookup), true);
  assert.equal(stillTrue(dirty('b'), lookup), false);
  assert.equal(stillTrue({ type: 'pr-unresolved', url: 'a' }, lookup), true);
  assert.equal(stillTrue({ type: 'pr-unresolved', url: 'b' }, lookup), false);
  assert.equal(stillTrue({ type: 'pr-merge', url: 'b', ok: true }, lookup), true);
  assert.equal(stillTrue(dirty('unknown'), lookup), true, 'an unknown PR cannot be checked, so it comes back');
});

test('parse keeps overdue held notifications, drops an ended snooze all and survives corrupt input', () => {
  const raw = JSON.stringify({ all: T0 - 1, held: [{ msg: needsYou('s1'), until: T0 - MIN }, { msg: { type: 'bogus' }, until: T0 }, null] });
  assert.deepEqual(parseSnoozes(raw, T0), { all: null, held: [{ key: 'session:s1', msg: needsYou('s1'), until: T0 - MIN }] });
  assert.deepEqual(parseSnoozes('{not json', T0), emptySnoozes());
  assert.deepEqual(parseSnoozes('null', T0), emptySnoozes());
  assert.deepEqual(parseSnoozes(null, T0), emptySnoozes());
});

test('store persists held notifications across reloads and hands them back when due', () => {
  let now = T0;
  const storage = memoryStorage();
  createSnoozeStore({ storage, now: () => now }).hold(needsYou('s1'), 5);
  const reloaded = createSnoozeStore({ storage, now: () => now });
  assert.equal(reloaded.nextWake(), T0 + 5 * MIN);
  assert.deepEqual(reloaded.takeDue(), []);
  now = T0 + 5 * MIN;
  assert.deepEqual(reloaded.takeDue(), [needsYou('s1')]);
  assert.deepEqual(createSnoozeStore({ storage, now: () => now }).get().held, []);
});

test('store snooze all holds new notifications for the rest of the snooze', () => {
  let now = T0;
  const store = createSnoozeStore({ storage: memoryStorage(), now: () => now });
  store.snoozeAll([needsYou('a')], 10);
  assert.equal(store.allActive(), true);
  now = T0 + 3 * MIN;
  store.holdForAll(dirty('u'));
  now = T0 + 10 * MIN;
  assert.equal(store.allActive(), false);
  assert.deepEqual(store.takeDue().map(notificationKey).sort(), ['pr:u', 'session:a']);
});

test('store supersede only writes when something was held', () => {
  const storage = memoryStorage();
  const store = createSnoozeStore({ storage, now: () => T0 });
  store.supersede(needsYou('s1'));
  assert.deepEqual(storage.data, {});
  store.hold(needsYou('s1'), 10);
  store.supersede(needsYou('s1'));
  assert.deepEqual(store.get().held, []);
});

test('store works when storage throws', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const store = createSnoozeStore({ storage, now: () => T0 });
  store.snoozeAll([], 10);
  assert.equal(store.allActive(), true);
  assert.equal(createSnoozeStore({ storage: null, now: () => T0 }).allActive(), false);
});

test('store notifies subscribers and reloads another tab\'s write', () => {
  const storage = memoryStorage();
  const store = createSnoozeStore({ storage, now: () => T0 });
  let calls = 0;
  store.subscribe(() => calls++);
  createSnoozeStore({ storage, now: () => T0 }).snoozeAll([], 5);
  assert.equal(store.allActive(), false);
  store.reload();
  assert.equal(store.allActive(), true);
  assert.equal(calls, 1);
});

class FakePopup extends EventTarget {
  closed = false;
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
}

test('snoozing one notification closes every pop-up open for its session or PR, and only those', () => {
  const popups = createPopupTracker();
  const conflicts = new FakePopup();
  const threads = new FakePopup();
  const other = new FakePopup();
  popups.track(dirty('u'), conflicts);
  popups.track({ type: 'pr-unresolved', url: 'u', delta: 1, count: 1 }, threads);
  popups.track(needsYou('s1'), other);
  popups.close([notificationKey(dirty('u'))]);
  assert.deepEqual([conflicts.closed, threads.closed, other.closed], [true, true, false]);
  assert.equal(popups.count(), 1);
  popups.close();
  assert.equal(other.closed, true);
  assert.equal(popups.count(), 0);
});

test('a pop-up the human closed is forgotten, and one that throws on close does not stop the rest', () => {
  const popups = createPopupTracker();
  const dismissed = new FakePopup();
  const broken = { close() { throw new Error('gone'); } };
  const fine = new FakePopup();
  popups.track(needsYou('a'), dismissed);
  popups.track(needsYou('b'), broken);
  popups.track(needsYou('b'), fine);
  dismissed.close();
  assert.equal(popups.count(), 2);
  popups.close();
  assert.equal(fine.closed, true);
  assert.equal(popups.count(), 0);
});
