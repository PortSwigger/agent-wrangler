import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdditionalFolders } from './additional-folders.js';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.value = ''; this.handlers = {}; this.dataset = {}; }
  append(...els) { this.children.push(...els); }
  replaceChildren(...els) { this.children = els; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  fire(name, event = {}) { this.handlers[name]?.({ preventDefault() {}, ...event }); }
  focus() { this.fire('focus'); }
  remove() { this.removed = true; }
}
function setup() {
  const doc = { createElement: (tag) => new Element(tag) };
  const list = new Element();
  const add = new Element('button');
  const sent = [];
  const picker = createAdditionalFolders({ list, add, document: doc, send: (msg) => sent.push(msg), recentFolders: () => ['/recent'] });
  return { picker, list, add, sent };
}

test('additional folder rows restore, trim, deduplicate, add and remove selections', () => {
  const { picker, list, add } = setup();
  picker.reset(['/first', '/second']);
  assert.deepEqual(picker.values(), ['/first', '/second']);
  const row = list.children[0];
  row.children[0].children[0].value = ' /second/ ';
  assert.deepEqual(picker.values(), ['/second']);
  row.children[1].fire('click');
  assert.deepEqual(picker.values(), ['/second']);
  add.fire('click');
  assert.deepEqual(picker.values(), ['/second']);
  picker.reset([]);
  assert.deepEqual(picker.values(), []);
});

test('folder browsing routes by field, ignores stale replies, and selection reads back', () => {
  const { picker, list, sent } = setup();
  picker.reset(['/first', '/second']);
  const input = list.children[0].children[0].children[0];
  input.focus();
  const request = sent.at(-1);
  assert.equal(request.path, '/first');
  assert.equal(request.type, 'browse-folders');
  assert.equal(picker.onBrowse({ ...request, field: undefined, entries: ['/wrong'] }), false);
  input.value = '/changed';
  picker.onBrowse({ ...request, entries: ['/stale'] });
  const suggestions = list.children[0].children[0].children[1];
  assert.ok(!suggestions.children.some((el) => el.textContent === '/stale'));
  input.fire('input');
  picker.onBrowse({ ...sent.at(-1), entries: ['/changed/child'], exists: true });
  suggestions.children.find((el) => el.textContent === '/changed/child').fire('mousedown');
  assert.deepEqual(picker.values(), ['/changed/child', '/second']);
  const old = sent.at(-1);
  picker.reset([]);
  assert.equal(picker.onBrowse({ ...old, entries: ['/late'] }), true);
  assert.deepEqual(picker.values(), []);
});

test('invalid folder replies block submission until edited or removed', () => {
  const { picker, list, sent } = setup();
  picker.reset(['/missing']);
  const input = list.children[0].children[0].children[0];
  input.focus();
  picker.onBrowse({ ...sent.at(-1), exists: false, entries: [] });
  assert.equal(picker.invalid(), true);
  input.value = '/valid';
  input.fire('input');
  assert.equal(picker.invalid(), false);
  picker.onBrowse({ ...sent.at(-1), exists: true, entries: [] });
  assert.equal(picker.invalid(), false);
});

test('keyboard navigation with no matches leaves Enter safe', () => {
  const { picker, list } = setup();
  picker.reset(['/no-matches']);
  const input = list.children[0].children[0].children[0];
  input.fire('keydown', { key: 'ArrowDown' });
  assert.doesNotThrow(() => input.fire('keydown', { key: 'Enter' }));
  assert.deepEqual(picker.values(), ['/no-matches']);
});

test('disabled folder picker suppresses grants and browsing but restores selections when enabled', () => {
  const { picker, list, add, sent } = setup();
  picker.reset(['/first']);
  picker.setEnabled(false);
  assert.equal(add.disabled, true);
  const input = list.children[0].children[0].children[0];
  assert.equal(input.disabled, true);
  assert.deepEqual(picker.values(), []);
  const count = list.children.length;
  add.fire('click');
  input.fire('input');
  assert.equal(list.children.length, count);
  assert.deepEqual(sent, []);
  picker.setEnabled(true);
  assert.equal(add.disabled, false);
  assert.equal(input.disabled, false);
  assert.deepEqual(picker.values(), ['/first']);
});
