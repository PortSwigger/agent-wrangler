import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToasts, MAX_TOASTS, SEVERITY_MS } from './toast.js';

// Just enough DOM for the stack: elements with children, classes, attributes,
// listeners and a popover state, plus a manual clock.
function fakeWorld() {
  const make = (tag) => {
    const classes = new Set();
    const el = {
      tag, children: [], parentNode: null, textContent: '', attrs: {}, listeners: {}, style: {}, hidden: false, popoverOpen: false, shows: 0,
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
      classList: { toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)), contains: (c) => classes.has(c) },
      get isConnected() { let n = el; while (n.parentNode) n = n.parentNode; return n === doc.body; },
      setAttribute(k, v) { el.attrs[k] = v; },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      fire(t, e = {}) { for (const fn of el.listeners[t] || []) fn({ stopPropagation() {}, ...e }); },
      click() { el.fire('click'); },
      matches: (sel) => (sel === ':popover-open' ? el.popoverOpen : false),
      showPopover() { el.popoverOpen = true; el.shows++; },
      hidePopover() { el.popoverOpen = false; },
      append(...kids) { for (const k of kids) { if (k.parentNode) k.remove(); k.parentNode = el; el.children.push(k); } },
      remove() { if (!el.parentNode) return; const p = el.parentNode; p.children.splice(p.children.indexOf(el), 1); el.parentNode = null; if (el.popoverOpen) el.popoverOpen = false; },
    };
    return el;
  };
  const doc = { createElement: make, getElementById: () => null };
  doc.body = make('body');
  let t = 0;
  const timers = new Map();
  let next = 1;
  const clock = {
    setTimeout: (fn, ms) => { timers.set(next, { fn, at: t + ms }); return next++; },
    clearTimeout: (id) => timers.delete(id),
    now: () => t,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
  return { doc, clock, toasts: createToasts({ document: doc, ...clock }) };
}

const stackOf = (doc) => doc.body.children.find((c) => c.attrs.popover === 'manual');
const shown = (doc) => (stackOf(doc)?.children || []).map((c) => c.children[0].textContent);
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
  part(stackOf(doc).children[0], 'toast-close').click();
  assert.deepEqual(shown(doc), []);
});

test('the legacy call shapes keep working: plain, isErr, one action, actions + duration', () => {
  const { doc, clock, toasts } = fakeWorld();
  let undone = 0;
  toasts.show('Task archived', false, { label: 'Restore task', duration: 10000, onClick: () => undone++ });
  const el = stackOf(doc).children[0];
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
  assert.equal(stackOf(doc).children[0].className, 'toast toast-error');
  assert.equal(stackOf(doc).children[0].attrs.role, 'alert');
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
  const el = stackOf(doc).children[0];
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
