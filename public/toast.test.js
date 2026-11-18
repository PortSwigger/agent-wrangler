import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToasts, MAX_TOASTS, SEVERITY_MS } from './toast.js';
import { fakeWorld } from './test-fixtures/toast-world.js';

const stackOf = (doc) => doc.body.children.find((c) => c.attrs.popover === 'manual');
const listOf = (doc) => stackOf(doc)?.children.find((c) => c.classList.contains('toast-list'));
const shown = (doc) => (listOf(doc)?.children || []).filter((c) => c.classList.contains('toast')).map((c) => c.children[0].textContent);
const part = (el, cls) => el.children.find((c) => c.className.split(' ').includes(cls));
const actionsOf = (el) => part(el, 'toast-actions').children;

test('notices use theme surface and text with a theme-derived top stripe and countdown track', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`${selector} {`)).match(/^[^{]+\{([^}]*)\}/)[1];
  const toast = rule('.toast');
  assert.match(toast, /background: var\(--surface\);/);
  assert.match(toast, /color: var\(--fg\);/);
  assert.doesNotMatch(toast, /border-left:/);
  assert.match(toast, /--toast-accent: var\(--accent\);/);
  for (const [severity, token] of [['success', 'green'], ['warning', 'warn'], ['error', 'red']]) {
    assert.equal(rule(`.toast-${severity}`).trim(), `--toast-accent: var(--${token});`);
  }
  assert.match(rule('.toast-progress'), /background: var\(--toast-accent\);/);
  for (const selector of ['.toast::before', '.toast-progress']) {
    assert.match(rule(selector), /top: 0; height: 4px; width: 100%;/);
    assert.doesNotMatch(rule(selector), /bottom:/);
  }
  assert.match(rule('.toast::before'), /background: var\(--toast-accent\);/);
  assert.match(rule('.toast:has(.toast-progress)::before'), /background: color-mix\(in srgb, var\(--toast-accent\) 30%, var\(--surface\)\);/);
  assert.match(css, /#toast:hover \.toast-progress, #toast:has\(:focus-visible\) \.toast-progress \{ animation-play-state: paused; \}/);
  for (const selector of ['.toast-action', '.toast-close']) assert.match(rule(selector), /color: inherit;/);
  assert.doesNotMatch(css, /--toast-(?:bg|fg)/);
});

test('shadow gutters preserve card offsets and the usable content height', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const stack = css.slice(css.indexOf('#toast {')).match(/^[^{]+\{([^}]*)\}/)[1];
  assert.match(stack, /box-sizing: content-box;/);
  assert.match(stack, /padding: 12px 12px 24px;/);
  assert.match(stack, /inset: calc\(var\(--toast-top\) - 12px\) 0 auto auto;/);
  assert.match(stack, /max-height: calc\(100dvh - var\(--toast-top\) - var\(--toast-bottom\)\);/);
  assert.match(stack, /max-width: min\(560px, calc\(100vw - 24px\)\);/);
  assert.match(css, /#toast\[data-position="bottom-right"\] \{ top: auto; bottom: calc\(var\(--toast-bottom\) - 24px\); \}/);
});

test('shadow padding passes pointer input through while cards and Clear all remain interactive', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`${selector} {`)).match(/^[^{]+\{([^}]*)\}/)[1];
  assert.match(rule('#toast'), /pointer-events: none;/);
  for (const selector of ['.toast', '.toast-clear']) assert.match(rule(selector), /pointer-events: auto;/);
});

test('Clear all has a separate fixed row outside the scrolling card list', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`${selector} {`)).match(/^[^{]+\{([^}]*)\}/)[1];
  assert.match(rule('#toast'), /overflow: visible;/);
  assert.match(rule('.toast-list'), /overflow-y: auto;/);
  assert.match(rule('.toast-list'), /min-height: 0;/);
  assert.match(rule('.toast-list'), /padding: 12px 12px 24px; margin: -12px -12px -24px;/);
  assert.match(rule('#toast'), /gap: 8px;/);
  assert.doesNotMatch(rule('.toast-clear'), /position: sticky;/);
  assert.match(rule('.toast-clear'), /flex-shrink: 0;/);
  for (const position of ['top-right', 'bottom-right']) {
    const { doc, toasts } = fakeWorld({ position });
    toasts.show('First', 'error');
    toasts.showPersistent('request', { title: 'Second', actions: [], onDismiss() {} });
    const stack = stackOf(doc);
    const list = part(stack, 'toast-list');
    const clear = part(stack, 'toast-clear');
    assert.equal(clear.hidden, false);
    assert.equal(list.children.length, 2);
    assert.deepEqual(stack.children, position === 'top-right' ? [clear, list] : [list, clear]);
    list.scrollTop = 100;
    assert.equal(clear.parentNode, stack);
    clear.click();
    assert.equal(toasts.count(), 0);
  }
});

test('overflowing lists contain their shadow gutters inside the allocated rows', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.toast-list\[data-overflow="true"\] \{([^}]*)\}/)?.[1];
  assert.ok(rule, 'overflow needs a bounded scrollport');
  assert.match(rule, /margin-top: 0;/);
  assert.match(rule, /margin-bottom: 0;/);
  for (const position of ['top-right', 'bottom-right']) {
    const { doc, toasts } = fakeWorld({ position });
    toasts.showPersistent('first', { title: 'First', actions: [] });
    const list = listOf(doc);
    Object.defineProperty(list, 'clientHeight', { get: () => 300 });
    Object.defineProperty(list, 'scrollHeight', { get: () => toasts.count() * 60 });
    for (let i = 1; i < 16; i++) toasts.showPersistent(String(i), { title: `Card ${i}`, actions: [] });
    assert.equal(list.attrs['data-overflow'], 'true', position);
    for (let i = 1; i < 16; i++) toasts.dismissPersistent(String(i));
    assert.equal(list.attrs['data-overflow'], 'false', 'short stacks recover their full shadow gutters');
  }
});

test('modal control rows leave overflowing stacks anchored to the viewport', () => {
  for (const position of ['top-right', 'bottom-right']) {
    for (const kind of ['settings', 'modal-card', 'file-viewer', 'terminal']) {
      const { doc, clock } = fakeWorld();
      doc.documentElement = {};
      doc.defaultView = { innerWidth: 1120, innerHeight: 640, MutationObserver: class { observe() {} } };
      const native = kind === 'terminal';
      const modal = doc.createElement(native ? 'dialog' : 'div');
      modal.open = native;
      doc.body.append(modal);
      const row = doc.createElement('div');
      const footer = kind === 'settings' || kind === 'modal-card';
      row.closest = (selector) => selector === 'dialog' ? (native ? modal : null) : modal;
      row.matches = (selector) => footer && selector.includes('.modal-actions');
      row.getBoundingClientRect = () => footer
        ? { left: 100, right: 1020, top: 513, bottom: 539, width: 920, height: 26 }
        : { left: 100, right: 1020, top: 80, bottom: 112, width: 920, height: 32 };
      const rowSelector = footer ? '.modal-actions' : native ? '.terminal-dialog-head' : '.file-head';
      doc.querySelectorAll = (selector) => selector === 'dialog:modal'
        ? (native ? [modal] : []) : selector.includes(rowSelector) ? [row] : [];
      const toasts = createToasts({ document: doc, position, ...clock });
      toasts.showPersistent('first', { title: 'First', actions: [] });
      const stack = native ? modal.children[0] : stackOf(doc);
      const list = part(stack, 'toast-list');
      list.clientHeight = 300;
      Object.defineProperty(list, 'scrollHeight', { get: () => toasts.count() * 60 });
      for (let i = 1; i < 16; i++) toasts.showPersistent(String(i), { title: `Card ${i}`, actions: [] });
      assert.equal(stack.style['--toast-top'], '12px', kind);
      assert.equal(stack.style['--toast-bottom'], '12px', kind);
      assert.equal(list.attrs['data-overflow'], 'true', `${kind}: scrollport must stay within the reserved area`);
    }
  }
});

test('opening and closing native dialogs preserves corner offsets in both positions', () => {
  for (const position of ['top-right', 'bottom-right']) {
    const { doc, clock } = fakeWorld();
    let observe;
    doc.documentElement = {};
    doc.defaultView = { innerWidth: 1000, innerHeight: 800, MutationObserver: class { constructor(fn) { observe = fn; } observe() {} } };
    const dialog = doc.createElement('dialog');
    dialog.tagName = 'DIALOG';
    dialog.matches = (selector) => selector === ':modal' && dialog.open;
    doc.body.append(dialog);
    const head = doc.createElement('header');
    head.closest = (selector) => selector === 'dialog' ? dialog : null;
    head.getBoundingClientRect = () => ({ left: 400, right: 1000, top: 0, bottom: 72, width: 600, height: 72 });
    doc.querySelectorAll = (selector) => selector === 'dialog:modal' ? [] : [head];
    const toasts = createToasts({ document: doc, position, ...clock });
    toasts.show('Visible', 'error');
    const stack = stackOf(doc);
    dialog.open = true;
    observe([{ type: 'attributes', attributeName: 'open', target: dialog }]);
    assert.equal(stack.style['--toast-top'], '12px');
    assert.equal(stack.parentNode, dialog);
    dialog.open = false;
    observe([{ type: 'attributes', attributeName: 'open', target: dialog }]);
    assert.equal(stack.parentNode, doc.body);
    assert.equal(stack.style['--toast-top'], '12px');
    assert.equal(stack.style['--toast-bottom'], '12px');
  }
});

test('every timed toast has a countdown stripe and untimed notices have a solid stripe', () => {
  const { doc, toasts } = fakeWorld();
  const latest = () => listOf(doc).children.filter((c) => c.classList.contains('toast')).at(-1);
  for (const severity of ['success', 'info', 'warning', 'error']) {
    toasts.show(severity, severity);
    const bar = part(latest(), 'toast-progress');
    if (severity === 'error') assert.equal(bar, undefined);
    else assert.equal(bar.style.animationDuration, `${SEVERITY_MS[severity]}ms`);
  }
  toasts.show('Timed error', 'error', { duration: 15000 });
  assert.equal(part(latest(), 'toast-progress').style.animationDuration, '15000ms');
  toasts.show('Untimed action', 'info', { duration: Infinity, actions: [{ label: 'Act', onClick() {} }] });
  assert.equal(part(latest(), 'toast-progress'), undefined);
  toasts.showPersistent('request', { title: 'Persistent', actions: [], onDismiss() {} });
  assert.equal(part(latest(), 'toast-progress'), undefined);
});

test('centred modal headers do not move toasts at either position', () => {
  for (const position of ['top-right', 'bottom-right']) {
    for (const native of [true, false]) {
      const { doc, clock } = fakeWorld();
      doc.documentElement = {};
      doc.defaultView = {
        innerWidth: 1400, innerHeight: 900,
        MutationObserver: class { observe() {} disconnect() {} },
      };
      const modal = doc.createElement(native ? 'dialog' : 'div');
      modal.open = true;
      doc.body.append(modal);
      const head = doc.createElement('div');
      head.closest = (selector) => selector === 'dialog' ? (native ? modal : null) : (native ? null : modal);
      head.getBoundingClientRect = () => ({ left: 250, right: 1150, top: 150, bottom: 190, width: 900, height: 40 });
      const lowerHead = doc.createElement('header');
      lowerHead.closest = head.closest;
      lowerHead.getBoundingClientRect = () => ({ left: 250, right: 1150, top: 346, bottom: 380, width: 900, height: 34 });
      modal.append(head, lowerHead);
      doc.querySelectorAll = (selector) => selector === 'dialog:modal' ? (native ? [modal] : []) : [lowerHead, head];
      const toasts = createToasts({ document: doc, position, ...clock });
      toasts.show('Visible');
      toasts.showPersistent('request', { title: 'Action needed', actions: [], onDismiss() {} });
      const stack = modal.children.find((el) => el.attrs.popover === 'manual') || stackOf(doc);
      assert.equal(stack.style['--toast-top'], '12px');
      assert.ok(900 - parseInt(stack.style['--toast-top']) - parseInt(stack.style['--toast-bottom']) >= 120);
    }
  }
});

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
  part(listOf(doc).children.find((c) => c.classList.contains('toast')), 'toast-close').click();
  assert.deepEqual(shown(doc), []);
});

test('the legacy call shapes keep working: plain, isErr, one action, actions + duration', () => {
  const { doc, clock, toasts } = fakeWorld();
  let undone = 0;
  toasts.show('Task archived', false, { label: 'Restore task', duration: 10000, onClick: () => undone++ });
  const el = listOf(doc).children.find((c) => c.classList.contains('toast'));
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
  assert.equal(listOf(doc).children.find((c) => c.classList.contains('toast')).className, 'toast toast-error');
  assert.equal(listOf(doc).children.find((c) => c.classList.contains('toast')).attrs.role, 'alert');
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
  const el = listOf(doc).children.find((c) => c.classList.contains('toast'));
  const more = part(el, 'toast-details');
  const expander = part(part(el, 'toast-actions'), 'toast-more');
  assert.equal(more.textContent, '• a\n• b\n• c');
  assert.equal(more.hidden, true);
  assert.equal(expander.hidden, false);
  expander.click();
  assert.equal(part(el, 'toast-progress'), undefined, 'opening Details restores a solid stripe');
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

test('layout batches into one animation frame and releases observers and pending work when empty', () => {
  const { doc, clock } = fakeWorld();
  const frames = new Map();
  const observed = new Set();
  const events = new Map();
  let nextFrame = 0;
  let mutation;
  let resize;
  let reads = 0;
  let mutationActive = false;
  doc.documentElement = {};
  doc.defaultView = {
    innerWidth: 1000, innerHeight: 800,
    requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name) => events.delete(name),
    MutationObserver: class {
      constructor(fn) { mutation = fn; }
      observe() { mutationActive = true; }
      disconnect() { mutationActive = false; }
    },
    ResizeObserver: class {
      constructor(fn) { resize = fn; }
      observe(el) { observed.add(el); }
      unobserve(el) { observed.delete(el); }
      disconnect() { observed.clear(); }
    },
  };
  doc.addEventListener = (name, fn) => events.set(name, fn);
  doc.removeEventListener = (name) => events.delete(name);
  doc.querySelectorAll = () => [];
  const toasts = createToasts({ document: doc, ...clock });
  toasts.show('First');
  const stack = stackOf(doc);
  Object.defineProperty(listOf(doc), 'scrollHeight', { get: () => { reads++; return 900; } });
  toasts.setPosition('bottom-right');
  reads = 0;
  resize();
  mutation([]);
  events.get('scroll')();
  assert.equal(reads, 0, 'geometry waits until the animation frame');
  assert.equal(frames.size, 1);
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); for (const fn of callbacks) fn(); };
  flush();
  assert.equal(reads, 2, 'one overflow measurement and one scroll to the newest notice');
  assert.equal(stackOf(doc).style['--toast-top'], '12px');
  assert.equal(listOf(doc).scrollTop, 900, 'newest notice stays visible after the frame changes the available height');
  events.get('resize')();
  toasts.clear();
  assert.equal(frames.size, 0);
  assert.equal(observed.size, 0);
  assert.equal(mutationActive, false);
  assert.equal(events.size, 0);
  toasts.show('Again');
  flush();
  assert.equal(stackOf(doc).style['--toast-top'], '12px');
  assert.equal(mutationActive, true);
  assert.ok(observed.has(listOf(doc)));
});
