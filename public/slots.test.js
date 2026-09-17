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

function harness(opts = {}) {
  const document = stubDocument();
  const errors = [];
  const slots = createSlots({ document, storage: null, onError: (msg) => errors.push(String(msg)), ...opts });
  return { document, slots, errors };
}

test('register refuses an unknown slot name and a malformed contribution', () => {
  const { slots } = harness();
  assert.throws(() => slots.register('panel.footer', 'x', { id: 'a', mount() {} }), /Unknown slot "panel.footer"/);
  assert.throws(() => slots.register('panel.section', 'x', { mount() {} }), /has no id/);
  assert.throws(() => slots.register('panel.section', 'x', { id: 'a' }), /no mount function/);
  slots.register('panel.section', 'x', { id: 'a', mount() {} });
  assert.throws(() => slots.register('panel.section', 'x', { id: 'a', mount() {} }), /already registered/);
  assert.deepEqual(SLOT_NAMES, ['panel.section', 'panel.metaChip', 'card.pill', 'view']);
  // A view needs a label before it has a host: the rail button is drawn from it.
  assert.throws(() => slots.register('view', 'x', { id: 'v', mount() {} }), /in view has no label/);
  slots.register('view', 'x', { id: 'v', label: 'Jobs', mount() {} });
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
  // The api carries the base plus a per-extension storage, stable by identity —
  // and its own `send`, wrapping the base one (see the bound-send tests below).
  assert.equal(typeof mounts[0][2].send, 'function');
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

test('syncHosts mounts one element per card host and updates each with its own session', () => {
  const { document, slots } = harness();
  const updates = [];
  slots.register('card.pill', 'a', { id: 'pill', mount() {}, update: (el, s) => updates.push([el, s?.sessionId]) });
  const h1 = document.make(); const h2 = document.make();
  const s1 = { sessionId: 's1' }; const s2 = { sessionId: 's2' };
  assert.equal(slots.syncHosts('card.pill', [{ host: h1, session: s1 }, { host: h2, session: s2 }], {}, { g: 1 }), 2);
  assert.equal(h1.children.length, 1);
  assert.equal(h2.children.length, 1);
  assert.deepEqual(updates.map(([, id]) => id), ['s1', 's2'], 'each host is updated with ITS card\'s session');
  assert.notEqual(updates[0][0], updates[1][0], 'a separate element per host');
  // A second pass over the SAME hosts re-updates without re-mounting.
  slots.syncHosts('card.pill', [{ host: h1, session: s1 }, { host: h2, session: s2 }], {});
  assert.equal(h1.children.length, 1);
  assert.deepEqual(updates.map(([, id]) => id), ['s1', 's2', 's1', 's2']);
});

test('syncHosts tears down a host left out of the set, and mountInto still means one host only', () => {
  const { document, slots } = harness();
  const log = [];
  slots.register('card.pill', 'a', { id: 'pill', mount: (el) => log.push(['mount', el]), unmount: (el) => log.push(['unmount', el]) });
  const h1 = document.make(); const h2 = document.make();
  slots.syncHosts('card.pill', [{ host: h1 }, { host: h2 }], {});
  const firstEl = h1.children[0];
  // The card h1 rendered is gone: its element is torn down by omission, h2 keeps its own.
  assert.equal(slots.syncHosts('card.pill', [{ host: h2 }], {}), 1);
  assert.equal(h1.children.length, 0);
  assert.equal(h2.children.length, 1);
  assert.deepEqual(log.filter(([k]) => k === 'unmount').map(([, el]) => el), [firstEl]);
  // Nothing on screen at all (a board with no cards) tears the slot right down.
  assert.equal(slots.syncHosts('card.pill', [], {}), 0);
  assert.equal(h2.children.length, 0);
  assert.equal(slots.contributions('card.pill')[0].mounted, false);
  // An entry with no host is skipped rather than mounted anywhere.
  assert.equal(slots.syncHosts('card.pill', [{ host: null, session: { sessionId: 'x' } }], {}), 0);
});

test('a throwing card contribution is removed from EVERY host, not just the one that threw', () => {
  const { document, slots, errors } = harness();
  const good = [];
  slots.register('card.pill', 'bad', { id: 'pill', mount() {}, update(el, s) { if (s.sessionId === 's2') throw new Error('boom'); } });
  slots.register('card.pill', 'good', { id: 'pill', mount() {}, update: (el, s) => good.push(s.sessionId) });
  const h1 = document.make(); const h2 = document.make();
  slots.syncHosts('card.pill', [{ host: h1, session: { sessionId: 's1' } }, { host: h2, session: { sessionId: 's2' } }], {});
  assert.deepEqual(slots.contributions('card.pill').map((c) => c.extId), ['good']);
  assert.deepEqual(h1.children.map((c) => c.dataset.ext), ['good'], 'the first host loses it too');
  assert.deepEqual(h2.children.map((c) => c.dataset.ext), ['good']);
  assert.deepEqual(good, ['s1', 's2']);
  assert.match(errors[0], /\[ext:bad\] pill update failed/);
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


// ── The `view` slot ───────────────────────────────────────────────────────
// A view's host is ITS host, not a shared one: `only` is what keeps two views
// out of each other's pane (every other slot deliberately puts every
// contribution into every host).
test('syncHosts with `only` mounts each view into its own host and nowhere else', () => {
  const { document, slots } = harness();
  slots.register('view', 'jobs', { id: 'board', label: 'Jobs', mount() {} });
  slots.register('view', 'logs', { id: 'stream', label: 'Logs', mount() {} });
  const jobsHost = document.make();
  const logsHost = document.make();
  slots.syncHosts('view', [
    { host: jobsHost, only: { extId: 'jobs', id: 'board' } },
    { host: logsHost, only: { extId: 'logs', id: 'stream' } },
  ]);
  assert.equal(jobsHost.children.length, 1);
  assert.equal(jobsHost.children[0].dataset.ext, 'jobs');
  assert.equal(logsHost.children.length, 1);
  assert.equal(logsHost.children[0].dataset.ext, 'logs');
});

test('a view left out of the entry list is torn down, and the others are untouched', () => {
  const { document, slots } = harness();
  const unmounted = [];
  slots.register('view', 'jobs', { id: 'board', label: 'Jobs', mount() {}, unmount: () => unmounted.push('jobs') });
  slots.register('view', 'logs', { id: 'stream', label: 'Logs', mount() {} });
  const jobsHost = document.make();
  const logsHost = document.make();
  const all = [
    { host: jobsHost, only: { extId: 'jobs', id: 'board' } },
    { host: logsHost, only: { extId: 'logs', id: 'stream' } },
  ];
  slots.syncHosts('view', all);
  slots.syncHosts('view', [all[1]]);
  assert.deepEqual(unmounted, ['jobs']);
  assert.equal(jobsHost.children.length, 0);
  assert.equal(logsHost.children.length, 1, 'a host nobody addressed this round is not a host to evict from');
});

test('contributions carries the label and icon the board draws a rail button from', () => {
  const { slots } = harness();
  slots.register('view', 'jobs', { id: 'board', label: 'Jobs', icon: '<svg/>', mount() {} });
  assert.deepEqual(slots.contributions('view'), [{ extId: 'jobs', id: 'board', mounted: false, label: 'Jobs', icon: '<svg/>' }]);
  // Absent rather than undefined for the slots that need neither.
  slots.register('panel.section', 'jobs', { id: 'p', mount() {} });
  assert.deepEqual(slots.contributions('panel.section'), [{ extId: 'jobs', id: 'p', mounted: false }]);
});

test('an entry with no `only` still reaches every contribution (card.pill is unchanged)', () => {
  const { document, slots } = harness();
  slots.register('card.pill', 'a', { id: 'pill', mount() {} });
  slots.register('card.pill', 'b', { id: 'pill', mount() {} });
  const host = document.make();
  slots.syncHosts('card.pill', [{ host, session: { sessionId: 'CARD1' } }]);
  assert.equal(host.children.length, 2);
});

// ── The bound `send` (the browser mirror of the server façade's forced values) ──
// An extension may only drive the control handlers IT registered: without this,
// an extension's client half could send `dispatch` or another extension's frame,
// which is exactly what the server-side façade stops it doing over MCP.
function sendHarness(types) {
  const sent = [];
  const h = harness({ handlerTypesFor: () => types, version: '9.9.9' });
  const api = { send: (f) => sent.push(f) };
  let captured = null;
  h.slots.register('panel.section', 'fake', { id: 'a', mount(el, a) { captured = a; } });
  h.slots.mountInto('panel.section', h.document.make(), api);
  return { ...h, sent, api: captured };
}

test('send forwards a frame whose type the extension registered', () => {
  const { api, sent, errors } = sendHarness(['fake-do']);
  api.send({ type: 'fake-do', text: 'x' });
  assert.deepEqual(sent, [{ type: 'fake-do', text: 'x' }]);
  assert.deepEqual(errors, []);
});

test('send drops a frame whose type the extension did not register, and reports it', () => {
  const { api, sent, errors } = sendHarness(['fake-do']);
  api.send({ type: 'dispatch', cwd: '/' });
  api.send({ type: 'other-ext-do' });
  api.send('not a frame');
  assert.deepEqual(sent, [], 'nothing reached the socket');
  assert.equal(errors.length, 3);
  assert.match(errors[0], /\[ext:fake\] send refused: "dispatch"/);
  assert.match(errors[2], /send refused: "null"/);
});

test('an extension with no known handler types fails CLOSED', () => {
  const { api, sent, errors } = sendHarness([]);
  api.send({ type: 'fake-do' });
  assert.deepEqual(sent, []);
  assert.match(errors[0], /\(none\)/);
});

test('the api carries the host API version', () => {
  assert.equal(sendHarness(['fake-do']).api.version, '9.9.9');
});
