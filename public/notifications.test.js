import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createNotifications, MAX_ACTIONS } from './notifications.js';
import { toast, dismissToast, getToasts, setToastPosition } from './toast.js';
import { fakeWorld } from './test-fixtures/toast-world.js';

const fakeDocument = () => {
  const { doc } = fakeWorld();
  getToasts(doc).setPosition('bottom-right');
  return doc;
};
const cards = (doc) => (doc.body.children[0]?.children.find((c) => c.classList.contains('toast-list'))?.children || []).filter((c) => c.classList.contains('toast'));
const find = (el, cls) => el.children.find((c) => c.className.split(' ').includes(cls));
const buttons = (card) => find(card, 'toast-actions').children.filter((c) => !c.hidden);

test('cards stack in order and each resolves with its own clicked action', async () => {
  const doc = fakeDocument();
  const n = createNotifications({ document: doc });
  const a = n.show('ext', { id: 'a', title: 'A', body: 'why', actions: [{ id: 'yes', label: 'Yes', primary: true }, { id: 'no', label: 'No' }] });
  const b = n.show('ext', { id: 'b', title: 'B', actions: [{ id: 'yes', label: 'Yes' }] });
  assert.deepEqual(cards(doc).map((c) => find(c, 'toast-text').textContent), ['A', 'B']);
  assert.equal(find(cards(doc)[0], 'toast-body').textContent, 'why');
  assert.equal(find(cards(doc)[1], 'toast-body'), undefined);
  assert.ok(buttons(cards(doc)[0])[0].classList.contains('toast-action-primary'));
  buttons(cards(doc)[1])[0].click();
  assert.equal(await b, 'yes');
  assert.equal(cards(doc).length, 1);
  find(cards(doc)[0], 'toast-close').click();
  assert.equal(await a, null);
  assert.equal(cards(doc).length, 0);
});

test('the same id updates in place and every waiter gets the answer', async () => {
  const doc = fakeDocument();
  const n = createNotifications({ document: doc });
  const first = n.show('ext', { id: 'a', title: 'Old', actions: [{ id: 'x', label: 'X' }] });
  const second = n.show('ext', { id: 'a', title: 'New', actions: [{ id: 'x', label: 'X' }] });
  assert.equal(cards(doc).length, 1);
  assert.equal(find(cards(doc)[0], 'toast-text').textContent, 'New');
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
  assert.deepEqual(cards(doc).map((c) => find(c, 'toast-text').textContent), ['theirs']);
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
  const fire = new Function('notifications', 'tryFulfillScheduledFocus', 'cardOf', `
    let pendingScheduledFocus;
    let scheduleNotificationId = 0;
    ${source.slice(start, end)}
    return onScheduleFired;
  `)(notifications, () => selected.push('viewed'), (sid) => `d1/${sid}`);
  fire({ id: 'daily', name: 'Daily work', sessionId: 'CARD1' });
  fire({ id: 'daily', name: 'Daily work', sessionId: 'CARD2' });
  assert.equal(cards(doc).length, 2);
  notifications.clear('core');
  await Promise.resolve();
  assert.equal(cards(doc).length, 2);
  find(cards(doc)[0], 'toast-close').click();
  await Promise.resolve();
  assert.deepEqual(selected, []);
  assert.equal(cards(doc).length, 1);
  buttons(cards(doc)[0])[0].click();
  await Promise.resolve();
  assert.deepEqual(selected, ['viewed']);
  assert.equal(cards(doc).length, 0);
});

test('Clear all dismisses mixed notices and all replacement waiters without taking actions', async () => {
  const { doc, toasts } = fakeWorld();
  const n = createNotifications({ document: doc, toasts });
  let actions = 0;
  toasts.show('Saved', 'success', { actions: [{ label: 'Undo', onClick: () => actions++ }] });
  const first = n.show('one', { id: 'a', title: 'Request', actions: [{ id: 'allow', label: 'Allow' }] });
  const replacement = n.show('one', { id: 'a', title: 'Updated request' });
  const second = n.show('two', { id: 'a', title: 'Another request' });
  assert.equal(doc.body.children.length, 1);
  assert.equal(toasts.count(), 3);
  const clear = find(find(doc.body.children[0], 'toast-head'), 'toast-clear');
  assert.equal(clear.textContent, 'Clear all');
  assert.equal(clear.hidden, false);
  assert.equal(clear.attrs.type ?? clear.type, 'button');
  clear.click();
  assert.deepEqual(await Promise.all([first, replacement, second]), [null, null, null]);
  assert.equal(actions, 0);
  assert.equal(toasts.count(), 0);
  assert.equal(clear.hidden, true);
  const fresh = n.show('one', { id: 'a', title: 'Fresh' });
  assert.equal(toasts.count(), 1);
  n.withdraw('one', 'a');
  assert.equal(await fresh, null);
});

test('persistent notices survive expiry and transient overflow without deduplicating across APIs', async () => {
  const { doc, clock, toasts } = fakeWorld();
  const n = createNotifications({ document: doc, toasts });
  const pending = Array.from({ length: 5 }, (_, i) => n.show('ext', { id: String(i), title: 'Same message' }));
  toasts.show('Same message', false, { id: 'ext:0' });
  for (let i = 0; i < 5; i++) toasts.show(`Notice ${i}`);
  assert.equal(cards(doc).length, 8);
  clock.advance(60000);
  assert.equal(cards(doc).length, 5);
  n.clear('ext');
  assert.deepEqual(await Promise.all(pending), [null, null, null, null, null]);
  assert.equal(toasts.count(), 0);
});

test('replacement keeps the same persistent card position and resolves using the latest actions', async () => {
  const { doc, toasts } = fakeWorld();
  const n = createNotifications({ document: doc, toasts });
  const first = n.show('ext', { id: 'a', title: 'Old', actions: [{ id: 'old', label: 'Old' }] });
  const card = cards(doc)[0];
  toasts.show('Later');
  const replacement = n.show('ext', { id: 'a', title: 'New', actions: [{ id: 'new', label: 'New' }] });
  assert.equal(cards(doc)[0], card);
  assert.equal(find(card, 'toast-text').textContent, 'New');
  buttons(card)[0].click();
  assert.deepEqual(await Promise.all([first, replacement]), ['new', 'new']);
  assert.equal(toasts.count(), 1);
});

test('the default notification adapter shares the stack used by board toast calls', async () => {
  const { doc } = fakeWorld();
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const n = createNotifications({ document: doc });
    const pending = n.show('ext', { id: 'a', title: 'Persistent' });
    toast('Transient', false, { id: 'a', duration: Infinity });
    assert.equal(doc.body.children.length, 1);
    assert.equal(cards(doc).length, 2);
    assert.deepEqual(cards(doc).map((card) => find(card, 'toast-text').textContent), ['Transient', 'Persistent']);
    setToastPosition('bottom-right');
    assert.deepEqual(cards(doc).map((card) => find(card, 'toast-text').textContent), ['Persistent', 'Transient']);
    assert.equal(doc.body.children[0].attrs['data-position'], 'bottom-right');
    setToastPosition('top-right');
    assert.deepEqual(cards(doc).map((card) => find(card, 'toast-text').textContent), ['Transient', 'Persistent']);
    dismissToast('a');
    assert.equal(cards(doc).length, 1);
    n.clear('ext');
    assert.equal(await pending, null);
    assert.equal(cards(doc).length, 0);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test('persistent cards and Clear all stay interactive through nested modals and modal removal', async () => {
  const { doc } = fakeWorld();
  let observe;
  doc.documentElement = {};
  doc.defaultView = { MutationObserver: class { constructor(fn) { observe = fn; } observe() {} } };
  const n = createNotifications({ document: doc });
  const first = n.show('ext', { id: 'a', title: 'Persistent' });
  const second = n.show('ext', { id: 'b', title: 'Another' });
  const stack = doc.body.children[0];
  const dialog = () => {
    const el = doc.createElement('dialog');
    el.tagName = 'DIALOG';
    el.open = true;
    el.matches = (selector) => selector === ':modal' && el.open;
    doc.body.append(el);
    return el;
  };
  const outer = dialog();
  observe([{ target: outer }]);
  assert.equal(stack.parentNode, outer);
  const inner = dialog();
  observe([{ target: inner }]);
  assert.equal(stack.parentNode, inner);
  observe([{ type: 'childList', target: outer }]);
  assert.ok(stack.parentNode === inner, 'content changes do not reorder the modal stack');
  inner.remove();
  observe([{ type: 'childList', target: doc.body }]);
  assert.equal(stack.parentNode, outer);
  assert.equal(stack.popoverOpen, true);
  assert.equal(find(stack, 'toast-list').children.length, 2);
  outer.open = false;
  observe([{ target: outer }]);
  assert.equal(stack.parentNode, doc.body);
  find(find(stack, 'toast-head'), 'toast-clear').click();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
});

test('a card held by Snooze all still settles when withdrawn, and resolves when answered after release', async () => {
  const doc = fakeDocument();
  const toasts = getToasts(doc);
  let all = false;
  toasts.setSnoozeHandlers({ title: () => 'Snooze', allActive: () => all, snooze() {}, snoozeAll: () => { all = true; } });
  const notifications = createNotifications({ document: doc, toasts });
  const withdrawn = notifications.show('ext', { id: 'one', title: 'One', actions: [{ id: 'ok', label: 'OK' }] });
  const answered = notifications.show('ext', { id: 'two', title: 'Two', actions: [{ id: 'ok', label: 'OK' }] });
  find(find(doc.body.children[0], 'toast-head'), 'toast-snooze-all').click();
  assert.equal(toasts.count(), 0);
  notifications.withdraw('ext', 'one');
  assert.equal(await withdrawn, null);
  all = false;
  toasts.releaseHeld();
  assert.equal(toasts.count(), 1);
  buttons(cards(doc)[0])[0].click();
  assert.equal(await answered, 'ok');
});
