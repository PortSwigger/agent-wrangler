import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToasts, MAX_TOASTS, SEVERITY_MS } from './toast.js';
import { fakeWorld } from './test-fixtures/toast-world.js';

const stackOf = (doc) => doc.body.children.find((c) => c.attrs.popover === 'manual');
const shown = (doc) => (stackOf(doc)?.children || []).filter((c) => c.classList.contains('toast')).map((c) => c.children[0].textContent);
const part = (el, cls) => el.children.find((c) => c.className.split(' ').includes(cls));
const actionsOf = (el) => part(el, 'toast-actions').children;

test('two toasts fired 0.3 s apart both stay up, newest last', () => {
  const { doc, clock, toasts } = fakeWorld();
  toasts.show('Session needs you', false);
  clock.advance(300);
  toasts.show('Schedule "nightly" failed', true);
  assert.deepEqual(shown(doc), ['Session needs you', 'Schedule "nightly" failed']);
  assert.equal(stackOf(doc).popoverOpen, true, 'the stack is a shown popover, so it sits in the top layer');
});

test('severity sets the lifetime: success 3 s, info 5 s, warning 8 s, error until closed', () => {
  assert.deepEqual(SEVERITY_MS, { success: 3000, info: 5000, warning: 8000, error: Infinity });
  const { doc, clock, toasts } = fakeWorld();
  toasts.show('ok', 'success');
  toasts.show('fyi');
  toasts.show('careful', 'warning');
  clock.advance(2999);
  assert.deepEqual(shown(doc), ['ok', 'fyi', 'careful']);
  clock.advance(1);
  assert.deepEqual(shown(doc), ['fyi', 'careful']);
  clock.advance(2000);
  assert.deepEqual(shown(doc), ['careful']);
  clock.advance(3000);
  assert.deepEqual(shown(doc), []);
  assert.equal(stackOf(doc).popoverOpen, false, 'an empty stack hides');
  toasts.show('broken', true);
  clock.advance(10 * 60 * 1000);
  assert.deepEqual(shown(doc), ['broken']);
  part(stackOf(doc).children.find((c) => c.classList.contains('toast')), 'toast-close').click();
  assert.deepEqual(shown(doc), []);
});

test('the legacy call shapes keep working: plain, isErr, one action, actions + duration', () => {
  const { doc, clock, toasts } = fakeWorld();
  let undone = 0;
  toasts.show('Task archived', false, { label: 'Restore task', duration: 10000, onClick: () => undone++ });
  const el = stackOf(doc).children.find((c) => c.classList.contains('toast'));
  assert.equal(el.className, 'toast toast-info');
  assert.equal(el.attrs.role, 'status');
  assert.equal(actionsOf(el)[0].textContent, 'Restore task');
  assert.equal(part(el, 'toast-progress').style.animationDuration, '10000ms');
  actionsOf(el)[0].click();
  assert.equal(undone, 1);
  assert.deepEqual(shown(doc), [], 'an action closes its toast');
  toasts.show('Copied', false, { duration: 1500 });
  clock.advance(1500);
  assert.deepEqual(shown(doc), []);
  toasts.show('Nope', true);
  assert.equal(stackOf(doc).children.find((c) => c.classList.contains('toast')).className, 'toast toast-error');
  assert.equal(stackOf(doc).children.find((c) => c.classList.contains('toast')).attrs.role, 'alert');
});

test('hovering the stack pauses every timer, and leaving resumes with the time left', () => {
  const { doc, clock, toasts } = fakeWorld();
  toasts.show('fyi');
  clock.advance(4000);
  stackOf(doc).fire('mouseenter');
  clock.advance(60000);
  assert.deepEqual(shown(doc), ['fyi']);
  toasts.show('arrived while hovered');
  clock.advance(60000);
  assert.equal(shown(doc).length, 2);
  stackOf(doc).fire('mouseleave');
  clock.advance(999);
  assert.deepEqual(shown(doc), ['fyi', 'arrived while hovered']);
  clock.advance(1);
  assert.deepEqual(shown(doc), ['arrived while hovered']);
  clock.advance(4000);
  assert.deepEqual(shown(doc), []);
});

test('a 4th toast evicts the oldest plain one before an action toast or an error', () => {
  const { doc, toasts } = fakeWorld();
  toasts.show('broken', true);
  toasts.show('archived', false, { label: 'Resume', onClick() {}, duration: 10000 });
  toasts.show('note one');
  toasts.show('note two');
  assert.equal(MAX_TOASTS, 3);
  assert.deepEqual(shown(doc), ['broken', 'archived', 'note two']);
  toasts.show('another error', true);
  assert.deepEqual(shown(doc), ['broken', 'archived', 'another error']);
  toasts.show('third error', true);
  assert.deepEqual(shown(doc), ['broken', 'another error', 'third error'], 'with no plain toast left, the action toast goes before an error');
});

test('the same message restarts its toast, and the same id replaces in place', () => {
  const { doc, clock, toasts } = fakeWorld();
  toasts.show('Not connected', true);
  toasts.show('fyi');
  toasts.show('Not connected', true);
  assert.deepEqual(shown(doc), ['fyi', 'Not connected']);
  toasts.show('Stopping background jobs…', false, { label: 'Resume', onClick() {}, id: 'archived:s1', duration: 10000 });
  clock.advance(10);
  toasts.show('Archived cleanly', false, { label: 'Resume', onClick() {}, id: 'archived:s1', duration: 10000 });
  assert.deepEqual(shown(doc), ['fyi', 'Not connected', 'Archived cleanly']);
});

test('details sit behind a Details expander that pins the toast open', () => {
  const { doc, clock, toasts } = fakeWorld();
  toasts.show('3 launch warnings', 'warning', { details: '• a\n• b\n• c' });
  const el = stackOf(doc).children.find((c) => c.classList.contains('toast'));
  const more = part(el, 'toast-details');
  const expander = part(part(el, 'toast-actions'), 'toast-more');
  assert.equal(more.textContent, '• a\n• b\n• c');
  assert.equal(more.hidden, true);
  assert.equal(expander.hidden, false);
  expander.click();
  assert.equal(more.hidden, false);
  assert.equal(expander.textContent, 'Less');
  assert.equal(el.classList.contains('expanded'), true);
  clock.advance(60000);
  assert.deepEqual(shown(doc), ['3 launch warnings'], 'an opened toast stays until closed');
  const plain = toasts.show('short');
  assert.equal(part(part(plain, 'toast-actions'), 'toast-more').hidden, true, 'no expander when nothing is hidden');
});

test('a modal dialog opening moves the stack inside it and re-shows it on top', () => {
  const { doc, toasts } = fakeWorld();
  let observe;
  const dialog = doc.createElement('dialog');
  dialog.tagName = 'DIALOG';
  dialog.matches = (sel) => sel === ':modal' && dialog.open;
  doc.body.append(dialog);
  doc.documentElement = {};
  doc.defaultView = { MutationObserver: class { constructor(fn) { observe = fn; } observe() {} } };
  const watched = createToasts({ document: doc, setTimeout: () => 0, clearTimeout() {}, now: () => 0 });
  watched.show('Something broke', true);
  const stack = doc.body.children.find((c) => c.attrs.popover === 'manual');
  assert.equal(stack.parentNode, doc.body);
  dialog.open = true;
  observe([{ target: dialog }]);
  assert.equal(stack.parentNode, dialog, 'inside the modal, so it is not inert');
  assert.equal(stack.popoverOpen, true);
  const shows = stack.shows;
  dialog.open = false;
  observe([{ target: dialog }]);
  assert.equal(stack.parentNode, doc.body, 'back on <body> when the dialog closes');
  assert.equal(stack.popoverOpen, true);
  assert.ok(stack.shows > shows);
  void toasts;
});

test('index.html declares the stack as a manual popover', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="toast" popover="manual"><\/div>/);
});

test('dismiss takes down the toast with that id and leaves the rest', () => {
  const { doc, toasts } = fakeWorld();
  toasts.show('fyi', false, { duration: Infinity });
  toasts.show('Asks to reach acme/c', 'warning', { id: 'repo-request:rr_1', duration: Infinity, actions: [{ label: 'Allow', onClick() {} }] });
  toasts.dismiss('repo-request:rr_1');
  toasts.dismiss('repo-request:gone');
  assert.deepEqual(shown(doc), ['fyi']);
});

test('Clear all appears only for multiple items and follows expiry and explicit dismissal', () => {
  const { doc, clock, toasts } = fakeWorld();
  toasts.show('First', 'success');
  const clear = part(stackOf(doc), 'toast-clear');
  assert.equal(clear.hidden, true);
  toasts.show('Second', 'info', { id: 'second' });
  assert.equal(clear.hidden, false);
  clock.advance(3000);
  assert.equal(clear.hidden, true);
  toasts.show('Third', true);
  assert.equal(clear.hidden, false);
  toasts.dismiss('second');
  assert.equal(clear.hidden, true);
  toasts.clear();
  assert.equal(clear.hidden, true);
  assert.equal(stackOf(doc).popoverOpen, false);
});

test('keyboard focus pauses timers until focus leaves the shared stack', () => {
  const { doc, clock, toasts } = fakeWorld();
  const first = toasts.show('First', 'success');
  const close = part(first, 'toast-close');
  close.matches = (selector) => selector === ':focus-visible';
  clock.advance(1000);
  stackOf(doc).fire('focusin', { target: close });
  clock.advance(10000);
  assert.deepEqual(shown(doc), ['First']);
  stackOf(doc).fire('focusout', { relatedTarget: doc.body });
  clock.advance(1999);
  assert.deepEqual(shown(doc), ['First']);
  clock.advance(1);
  assert.deepEqual(shown(doc), []);
});

test('top-right is the default, newest first; changing position reorders existing notices without dismissal', () => {
  const { doc, clock } = fakeWorld();
  const toasts = createToasts({ document: doc, ...clock });
  toasts.show('Old', false, { id: 'old' });
  clock.advance(1000);
  toasts.show('New');
  assert.equal(stackOf(doc).attrs['data-position'], 'top-right');
  assert.deepEqual(shown(doc), ['New', 'Old']);
  assert.equal(stackOf(doc).children[0].textContent, 'Clear all');
  toasts.setPosition('bottom-right');
  assert.equal(stackOf(doc).attrs['data-position'], 'bottom-right');
  assert.deepEqual(shown(doc), ['Old', 'New']);
  assert.equal(stackOf(doc).children.at(-1).textContent, 'Clear all');
  clock.advance(4000);
  assert.deepEqual(shown(doc), ['New'], 'position changes preserve the remaining lifetime');
  toasts.setPosition('top-right');
  toasts.show('Newest');
  assert.deepEqual(shown(doc), ['Newest', 'New']);
});

test('both positions reserve visible header controls and follow resized or hidden headers', () => {
  const { doc, clock } = fakeWorld();
  let observe;
  let resize;
  let height = 72;
  const header = doc.createElement('header');
  header.getBoundingClientRect = () => ({ left: 54, right: 1000, top: 0, bottom: height, width: 946, height });
  const offscreen = doc.createElement('header');
  offscreen.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 300, width: 200, height: 300 });
  const footer = doc.createElement('footer');
  footer.matches = () => true;
  footer.getBoundingClientRect = () => ({ left: 400, right: 900, top: 700, bottom: 750, width: 500, height: 50 });
  doc.documentElement = {};
  doc.defaultView = {
    innerWidth: 1000, innerHeight: 800,
    MutationObserver: class { constructor(fn) { observe = fn; } observe() {} },
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} unobserve() {} },
  };
  doc.querySelectorAll = (selector) => selector === 'dialog:modal' ? [] : [header, offscreen, footer];
  const toasts = createToasts({ document: doc, ...clock });
  toasts.show('Visible');
  assert.equal(stackOf(doc).style['--toast-top'], '80px');
  assert.equal(stackOf(doc).style['--toast-bottom'], '108px', 'modal footer controls remain unobscured');
  height = 110;
  resize();
  assert.equal(stackOf(doc).style['--toast-top'], '118px');
  toasts.setPosition('bottom-right');
  assert.equal(stackOf(doc).style['--toast-top'], '118px', 'bottom stack cannot grow over the header either');
  height = 0;
  observe([{ type: 'attributes', attributeName: 'class', target: header }]);
  assert.equal(stackOf(doc).style['--toast-top'], '16px');
});
