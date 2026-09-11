import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_NAMES, createSlots, namespacedStorage } from './slots.js';

// A DOM stub sufficient for the mount/update bookkeeping — no jsdom, matching
// the rest of public/'s tests.
function stubDocument() {
  const make = () => {
    const el = {
      children: [],
      className: '',
      dataset: {},
      parentNode: null,
      appendChild(c) { this.children.push(c); c.parentNode = el; return c; },
      removeChild(c) { const at = this.children.indexOf(c); if (at >= 0) this.children.splice(at, 1); c.parentNode = null; return c; },
    };
    return el;
  };
  return { createElement: make, make };
}

function harness() {
  const document = stubDocument();
  const errors = [];
  const slots = createSlots({ document, storage: null, onError: (msg) => errors.push(String(msg)) });
  return { document, slots, errors };
}

test('register refuses an unknown slot name and a malformed contribution', () => {
  const { slots } = harness();
  assert.throws(() => slots.register('panel.footer', 'x', { id: 'a', mount() {} }), /Unknown slot "panel.footer"/);
  assert.throws(() => slots.register('panel.section', 'x', { mount() {} }), /has no id/);
  assert.throws(() => slots.register('panel.section', 'x', { id: 'a' }), /no mount function/);
  slots.register('panel.section', 'x', { id: 'a', mount() {} });
  assert.throws(() => slots.register('panel.section', 'x', { id: 'a', mount() {} }), /already registered/);
  assert.deepEqual(SLOT_NAMES, ['panel.section', 'panel.metaChip', 'card.pill']);
});

test('forExtension binds the extension id so a module cannot register under another', () => {
  const { slots } = harness();
  const reg = slots.forExtension('checklist');
  reg.register('panel.section', { id: 'panel', mount() {} });
  assert.deepEqual(slots.contributions('panel.section'), [{ extId: 'checklist', id: 'panel', mounted: false }]);
});

test('mountInto creates one child per contribution and mounts once per host element', () => {
  const { document, slots } = harness();
  const mounts = [];
  slots.register('panel.metaChip', 'a', { id: 'pill', mount: (el, api) => mounts.push(['a', el, api]) });
  slots.register('panel.metaChip', 'b', { id: 'pill', mount: (el, api) => mounts.push(['b', el, api]) });
  const host = document.make();
  assert.equal(slots.mountInto('panel.metaChip', host, { send: 'S' }), 2);
  assert.equal(host.children.length, 2);
  assert.equal(host.children[0].dataset.ext, 'a');
  assert.equal(host.children[0].dataset.contrib, 'pill');
  assert.equal(host.children[0].className, 'ext-slot');
  assert.equal(mounts.length, 2);
  // Same host again: nothing re-mounted, no extra children.
  slots.mountInto('panel.metaChip', host, { send: 'S' });
  assert.equal(mounts.length, 2);
  assert.equal(host.children.length, 2);
  // The api carries the base plus a per-extension storage, stable by identity.
  assert.equal(mounts[0][2].send, 'S');
  assert.equal(typeof mounts[0][2].storage.get, 'function');
  assert.notEqual(mounts[0][2], mounts[1][2], 'each extension gets its own api object');
});

test('a fresh host element (an innerHTML-rebuilt chips row) re-mounts and unmounts the old element', () => {
  const { document, slots } = harness();
  const log = [];
  slots.register('panel.metaChip', 'a', { id: 'pill', mount: (el) => log.push(['mount', el]), unmount: (el) => log.push(['unmount', el]) });
  const host1 = document.make();
  slots.mountInto('panel.metaChip', host1, {});
  const first = log[0][1];
  const host2 = document.make();
  slots.mountInto('panel.metaChip', host2, {});
  assert.deepEqual(log.map(([k]) => k), ['mount', 'unmount', 'mount']);
  assert.equal(log[1][1], first);
  assert.equal(host2.children.length, 1);
  assert.equal(slots.contributions('panel.metaChip')[0].mounted, true);
});

test('update calls every mounted contribution and skips unmounted ones', () => {
  const { document, slots } = harness();
  const calls = [];
  slots.register('panel.section', 'a', { id: 'p', mount() {}, update: (el, s, g) => calls.push(['a', s, g]) });
  slots.register('panel.section', 'b', { id: 'p', mount() {}, update: (el, s, g) => calls.push(['b', s, g]) });
  slots.register('panel.section', 'c', { id: 'p', mount() {} }); // no update: fine
  slots.update('panel.section', { sessionId: 's1' }, { x: 1 });
  assert.deepEqual(calls, [], 'nothing mounted yet, nothing called');
  slots.mountInto('panel.section', document.make(), {});
  const graph = { checklists: {} };
  slots.update('panel.section', { sessionId: 's1' }, graph);
  assert.deepEqual(calls, [['a', { sessionId: 's1' }, graph], ['b', { sessionId: 's1' }, graph]]);
});

test('a throwing update removes only that contribution, reports it, and drops its element', () => {
  const { document, slots, errors } = harness();
  const calls = [];
  slots.register('panel.section', 'bad', { id: 'p', mount() {}, update() { throw new Error('boom'); } });
  slots.register('panel.section', 'good', { id: 'p', mount() {}, update: () => calls.push('good') });
  const host = document.make();
  slots.mountInto('panel.section', host, {});
  assert.equal(host.children.length, 2);
  slots.update('panel.section', null, {});
  assert.deepEqual(calls, ['good']);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].dataset.ext, 'good');
  assert.deepEqual(slots.contributions('panel.section').map((c) => c.extId), ['good']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\[ext:bad\] p update failed/);
  // The survivor keeps being updated afterwards.
  slots.update('panel.section', null, {});
  assert.deepEqual(calls, ['good', 'good']);
});

test('a throwing mount removes that contribution without stopping the others', () => {
  const { document, slots, errors } = harness();
  slots.register('panel.metaChip', 'bad', { id: 'p', mount() { throw new Error('nope'); } });
  slots.register('panel.metaChip', 'good', { id: 'p', mount() {} });
  const host = document.make();
  assert.equal(slots.mountInto('panel.metaChip', host, {}), 1);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].dataset.ext, 'good');
  assert.match(errors[0], /\[ext:bad\] p mount failed/);
});

test('removeExtension unmounts and drops every contribution of one extension across slots', () => {
  const { document, slots } = harness();
  const unmounted = [];
  slots.register('panel.section', 'a', { id: 'panel', mount() {}, unmount: () => unmounted.push('a-panel') });
  slots.register('panel.metaChip', 'a', { id: 'pill', mount() {}, unmount: () => unmounted.push('a-pill') });
  slots.register('panel.metaChip', 'b', { id: 'pill', mount() {} });
  const h1 = document.make(); const h2 = document.make();
  slots.mountInto('panel.section', h1, {});
  slots.mountInto('panel.metaChip', h2, {});
  slots.removeExtension('a');
  assert.deepEqual(unmounted.sort(), ['a-panel', 'a-pill']);
  assert.equal(h1.children.length, 0);
  assert.equal(h2.children.length, 1);
  assert.deepEqual(slots.contributions('panel.metaChip').map((c) => c.extId), ['b']);
  assert.deepEqual(slots.contributions('panel.section'), []);
});

test('namespacedStorage prefixes keys, swallows storage failures, and raw() escapes the prefix', () => {
  const backing = new Map();
  const fake = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  const s = namespacedStorage('ext.checklist.', fake);
  s.set('open', '1');
  assert.equal(backing.get('ext.checklist.open'), '1');
  assert.equal(s.get('open'), '1');
  assert.equal(s.get('missing'), null);
  s.remove('open');
  assert.equal(s.get('open'), null);
  s.raw('wrangler.checklistOpen').set('{"a":true}');
  assert.equal(backing.get('wrangler.checklistOpen'), '{"a":true}');
  assert.equal(s.raw('wrangler.checklistOpen').get(), '{"a":true}');

  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const t = namespacedStorage('p.', throwing);
  assert.equal(t.get('x'), null);
  assert.doesNotThrow(() => t.set('x', '1'));
  assert.doesNotThrow(() => t.remove('x'));
  const none = namespacedStorage('p.', undefined);
  assert.equal(none.get('x'), null);
  assert.doesNotThrow(() => none.set('x', '1'));
});
