import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createNotifications, MAX_ACTIONS } from './notifications.js';

// Just enough DOM for the stack: elements with children, text, attributes and
// click listeners.
function fakeDocument() {
  const make = (tag) => {
    const el = {
      tag, children: [], parentNode: null, className: '', textContent: '', attrs: {}, listeners: {},
      setAttribute(k, v) { el.attrs[k] = v; },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      click() { for (const fn of el.listeners.click || []) fn(); },
      append(...kids) { for (const k of kids) { k.parentNode = el; el.children.push(k); } },
      replaceChildren() { for (const k of el.children) k.parentNode = null; el.children = []; },
      remove() { if (!el.parentNode) return; const p = el.parentNode; p.children.splice(p.children.indexOf(el), 1); el.parentNode = null; },
    };
    return el;
  };
  return { body: make('body'), createElement: make };
}

const cards = (doc) => doc.body.children[0]?.children || [];
const find = (el, cls) => el.children.find((c) => c.className === cls);
const buttons = (card) => find(card, 'notif-actions').children;

test('cards stack in order and each resolves with its own clicked action', async () => {
  const doc = fakeDocument();
  const n = createNotifications({ document: doc });
  const a = n.show('ext', { id: 'a', title: 'A', body: 'why', actions: [{ id: 'yes', label: 'Yes', primary: true }, { id: 'no', label: 'No' }] });
  const b = n.show('ext', { id: 'b', title: 'B', actions: [{ id: 'yes', label: 'Yes' }] });
  assert.deepEqual(cards(doc).map((c) => find(c, 'notif-title').textContent), ['A', 'B']);
  assert.equal(find(cards(doc)[0], 'notif-body').textContent, 'why');
  assert.equal(find(cards(doc)[1], 'notif-body'), undefined);
  assert.equal(buttons(cards(doc)[0])[0].className, 'primary');
  buttons(cards(doc)[1])[0].click();
  assert.equal(await b, 'yes');
  assert.equal(cards(doc).length, 1);
  find(cards(doc)[0], 'notif-close').click();
  assert.equal(await a, null);
  assert.equal(cards(doc).length, 0);
});

test('the same id updates in place and every waiter gets the answer', async () => {
  const doc = fakeDocument();
  const n = createNotifications({ document: doc });
  const first = n.show('ext', { id: 'a', title: 'Old', actions: [{ id: 'x', label: 'X' }] });
  const second = n.show('ext', { id: 'a', title: 'New', actions: [{ id: 'x', label: 'X' }] });
  assert.equal(cards(doc).length, 1);
  assert.equal(find(cards(doc)[0], 'notif-title').textContent, 'New');
  buttons(cards(doc)[0])[0].click();
  assert.deepEqual(await Promise.all([first, second]), ['x', 'x']);
});

test('withdraw and clear only touch the owner\'s cards', async () => {
  const doc = fakeDocument();
  const n = createNotifications({ document: doc });
  const mine = n.show('one', { id: 'a', title: 'mine' });
  const theirs = n.show('two', { id: 'a', title: 'theirs' });
  const other = n.show('one', { id: 'b', title: 'other' });
  n.withdraw('one', 'a');
  assert.equal(await mine, null);
  n.clear('one');
  assert.equal(await other, null);
  assert.deepEqual(cards(doc).map((c) => find(c, 'notif-title').textContent), ['theirs']);
  n.withdraw('two', 'a');
  assert.equal(await theirs, null);
});

test('at most MAX_ACTIONS buttons are drawn', () => {
  const doc = fakeDocument();
  const n = createNotifications({ document: doc });
  n.show('ext', { id: 'a', title: 'T', actions: Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: String(i) })) });
  assert.equal(buttons(cards(doc)[0]).length, MAX_ACTIONS);
});

test('scheduled runs stack independently and stay until viewed or closed', async () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function onScheduleFired(msg) {');
  const end = source.indexOf('\nfunction tryFulfillScheduledFocus()', start);
  const doc = fakeDocument();
  const notifications = createNotifications({ document: doc });
  const selected = [];
  const fire = new Function('notifications', 'tryFulfillScheduledFocus', `
    let pendingScheduledFocus;
    let scheduleNotificationId = 0;
    ${source.slice(start, end)}
    return onScheduleFired;
  `)(notifications, () => selected.push('viewed'));
  fire({ id: 'daily', name: 'Daily work', sessionId: 'CARD1' });
  fire({ id: 'daily', name: 'Daily work', sessionId: 'CARD2' });
  assert.equal(cards(doc).length, 2);
  notifications.clear('core');
  await Promise.resolve();
  assert.equal(cards(doc).length, 2);
  find(cards(doc)[0], 'notif-close').click();
  await Promise.resolve();
  assert.deepEqual(selected, []);
  assert.equal(cards(doc).length, 1);
  buttons(cards(doc)[0])[0].click();
  await Promise.resolve();
  assert.deepEqual(selected, ['viewed']);
  assert.equal(cards(doc).length, 0);
});
