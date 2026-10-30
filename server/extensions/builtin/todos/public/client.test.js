import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ext, { weight, reset, COLLAPSED_KEY } from './client.js';
import { TODO_DIVIDER_PX, TODO_STRIDE_PX } from './todo.js';
import { todoAddHandler } from '../handlers.js';
import { fakeHost } from '../test-helpers.js';
import { createSlots } from '../../../../../public/slots.js';

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), _m: m };
}

function stubDocument() {
  const make = () => {
    const el = {
      children: [], className: '', dataset: {}, parentNode: null, attrs: {}, listeners: {},
      classList: { add() {}, remove() {}, contains: () => false },
      appendChild(c) { this.children.push(c); c.parentNode = el; return c; },
      removeChild(c) { const at = this.children.indexOf(c); if (at >= 0) this.children.splice(at, 1); c.parentNode = null; return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      contains: () => false,
      closest: () => null,
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html || ''; },
    };
    return el;
  };
  return { createElement: make, make, activeElement: null };
}

// Load the extension into a real slots instance, as extensions.js does.
function load({ storage = memStorage(), sent = [], renders = { n: 0 } } = {}) {
  const document = stubDocument();
  globalThis.document = document;
  const errors = [];
  const slots = createSlots({
    document, storage, onError: (...a) => errors.push(a), handlerTypesFor: () => ['todo-add', 'todo-edit', 'todo-delete', 'todo-move', 'todo-reorder'],
  });
  const baseApi = { send: (f) => sent.push(f), requestBoardRender: () => { renders.n += 1; } };
  ext.register(slots.forExtension('todos', baseApi));
  return { slots, document, errors, sent, renders, storage, baseApi };
}

beforeEach(() => reset());

function inlineEditor({ editing = false } = {}) {
  const env = load();
  const { slots, document, baseApi } = env;
  const host = document.make();
  const graph = { todos: editing ? { t1: [{ id: 'a', text: 'Original' }] } : {} };
  const hosts = [{ host, session: { taskId: 't1', adhocId: 'adhoc', container: host } }];
  slots.syncHosts('task.body', hosts, {}, graph);
  const el = host.children[0];
  const input = document.make();
  input.tagName = 'INPUT';
  input.focus = () => { document.activeElement = input; };
  input.select = () => {};
  input.blur = () => {
    if (document.activeElement !== input) return;
    document.activeElement = null;
    for (const fn of input.listeners.blur || []) fn();
  };
  const anchor = document.make();
  anchor.style = {};
  anchor.textContent = 'Original';
  anchor.querySelector = () => input;
  const row = { dataset: { todoid: 'a' }, querySelector: () => anchor };
  anchor.closest = (selector) => selector === '.todo-row' ? row : selector === '.todo-text' ? anchor : null;
  el.querySelector = () => anchor;
  el.contains = (node) => node === input;
  baseApi.requestBoardRender = () => {
    env.renders.n += 1;
    slots.syncHosts('task.body', hosts, {}, graph);
  };
  if (editing) {
    for (const fn of el.listeners.click) fn({ target: anchor, stopPropagation() {} });
  } else {
    slots.taskMenuItems({ id: 't1' }, {}, graph)[0].run();
  }
  return { ...env, el, graph, input };
}

for (const editing of [false, true]) {
  for (const key of ['Enter', 'Escape']) {
    test(`${key} finishes inline TODO ${editing ? 'editing' : 'creation'} immediately`, () => {
      const { el, graph, input, sent } = inlineEditor({ editing });
      input.value = '  Updated TODO  ';
      let prevented = false;
      let stopped = false;
      for (const fn of input.listeners.keydown) fn({
        key,
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
      });
      assert.equal(prevented, true);
      assert.equal(stopped, true);
      if (key === 'Enter') {
        assert.deepEqual(sent, [{ type: editing ? 'todo-edit' : 'todo-add', taskId: 't1', ...(editing ? { todoId: 'a' } : {}), text: 'Updated TODO' }]);
        assert.equal(graph.todos.t1[0].text, 'Updated TODO');
        assert.match(el.innerHTML, /Updated TODO/);
      } else {
        assert.deepEqual(sent, []);
        assert.deepEqual(graph.todos, editing ? { t1: [{ id: 'a', text: 'Original' }] } : {});
      }
      assert.notEqual(document.activeElement, input, 'a finished editor must no longer block board rendering');
      input.blur();
      assert.equal(sent.length, key === 'Enter' ? 1 : 0, 'blur must not save twice or save a cancelled edit');
    });
  }
}

test('registers a task.body zone with a weight and a task.action New TODO item', () => {
  const { slots } = load();
  assert.deepEqual(slots.contributions('task.body').map((c) => `${c.extId}:${c.id}`), ['todos:todos']);
  assert.deepEqual(slots.contributions('task.action').map((c) => `${c.extId}:${c.id}`), ['todos:new-todo']);
  const items = slots.taskMenuItems({ id: 't1', name: 'T', adhoc: false }, {}, {});
  assert.deepEqual(items.map((i) => i.label), ['New TODO']);
});

test('weight: nothing for an empty task, divider + rows for a task with todos, divider only when collapsed', () => {
  const { slots } = load();
  const graph = { todos: { t1: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] } };
  assert.equal(slots.taskBodyWeight('t2', graph), 0);
  assert.equal(slots.taskBodyWeight('t1', graph), TODO_DIVIDER_PX + 2 * TODO_STRIDE_PX);
  assert.equal(slots.taskBodyWeight('t1', {}), 0);
});

test('weight: collapse state is read from the same localStorage key the board used', () => {
  const storage = memStorage({ [COLLAPSED_KEY]: JSON.stringify(['t1']) });
  const { slots } = load({ storage });
  const graph = { todos: { t1: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], t2: [{ id: 'c', text: 'z' }] } };
  assert.equal(slots.taskBodyWeight('t1', graph), TODO_DIVIDER_PX);
  assert.equal(slots.taskBodyWeight('t2', graph), TODO_DIVIDER_PX + TODO_STRIDE_PX);
});

test('weight: unreadable stored collapse state means nothing is collapsed', () => {
  const { slots } = load({ storage: memStorage({ [COLLAPSED_KEY]: '{not json' }) });
  assert.equal(slots.taskBodyWeight('t1', { todos: { t1: [{ id: 'a', text: 'x' }] } }), TODO_DIVIDER_PX + TODO_STRIDE_PX);
});

test('weight alone (exported) works off the last graph it was given', () => {
  load();
  assert.equal(weight('t1', { todos: { t1: [{ id: 'a', text: 'x' }] } }), TODO_DIVIDER_PX + TODO_STRIDE_PX);
  assert.equal(weight('t1'), TODO_DIVIDER_PX + TODO_STRIDE_PX);
});

test('a host per tile: update draws the zone for ITS tile, unmount releases', () => {
  const { slots, document } = load();
  const hostA = document.make();
  const hostAdhoc = document.make();
  const graph = { todos: { t1: [{ id: 'a', text: 'alpha' }], adhoc: [{ id: 'b', text: 'beta' }] } };
  const ctx = (taskId, host) => ({ taskId, adhocId: 'adhoc', container: host });
  slots.syncHosts('task.body', [
    { host: hostA, session: ctx('t1', hostA) },
    { host: hostAdhoc, session: ctx('adhoc', hostAdhoc) },
  ], {}, graph);
  const slotA = hostA.children[0];
  const slotAdhoc = hostAdhoc.children[0];
  assert.equal('data-ext-drag' in slotA.attrs, false, 'a drag is claimed only while a row is being dragged');
  assert.match(slotA.innerHTML, /alpha/);
  assert.doesNotMatch(slotA.innerHTML, /beta/);
  assert.match(slotAdhoc.innerHTML, /beta/);
  slots.syncHosts('task.body', [], {}, graph);
  assert.equal(hostA.children.length, 0);
});

test('the New TODO menu item for a tile with no mounted host is a harmless no-op', () => {
  const { slots } = load();
  const [item] = slots.taskMenuItems({ id: 'ghost', name: 'G', adhoc: false }, {}, {});
  assert.doesNotThrow(() => item.run());
});

for (const adhoc of [false, true]) test(`New TODO creates and renders in ${adhoc ? 'Unassigned' : 'a named task'}`, async () => {
  const { slots, document, sent, renders, errors } = load();
  const { host: serverHost, store, calls } = fakeHost();
  const key = adhoc ? 'adhoc' : 't1';
  const host = document.make();
  const ctx = { taskId: key, adhocId: 'adhoc', container: host };
  const entries = [{ host, session: ctx }];
  const graph = { todos: {} };
  slots.syncHosts('task.body', entries, {}, graph);
  const el = host.children[0];
  const input = document.make();
  input.focus = () => { document.activeElement = input; };
  input.value = '  Follow up  ';
  const zone = document.make();
  zone.style = {};
  zone.querySelector = (selector) => selector === '.todo-add-input' ? input : null;
  el.querySelector = (selector) => selector === '.todo-zone' ? zone : null;
  const [item] = slots.taskMenuItems({ id: key, name: adhoc ? null : 'One', adhoc }, graph, {});
  assert.equal(item.label, 'New TODO');
  item.run();
  assert.equal(document.activeElement, input);
  input.listeners.keydown[0]({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  input.listeners.blur[0]();
  assert.deepEqual(sent, [{ type: 'todo-add', taskId: adhoc ? null : 't1', text: 'Follow up' }]);
  assert.equal(graph.todos[key][0].text, 'Follow up');
  assert.equal(renders.n, 1);
  await todoAddHandler.handler(sent[0], serverHost);
  assert.equal(calls.rebuild, 1);
  assert.deepEqual(Object.keys(store.snapshot().todos), [key]);
  slots.syncHosts('task.body', entries, {}, store.snapshot());
  assert.match(el.innerHTML, /Follow up/);
  assert.deepEqual(errors, []);
});
