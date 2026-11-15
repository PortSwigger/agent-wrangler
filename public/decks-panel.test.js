import { test } from 'node:test';
import assert from 'node:assert/strict';

function mkEl(tag) {
  const el = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, attrs: {}, className: '', textContent: '', title: '', value: '', type: '', placeholder: '', maxLength: 0, disabled: false, role: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { this.children.push(...c.filter(Boolean)); },
    replaceChildren(...c) { this.children = c.filter(Boolean); },
    addEventListener() {},
    contains() { return false; },
    querySelectorAll() { return []; },
  };
  return el;
}
globalThis.document = { createElement: mkEl, activeElement: null };
globalThis.location = { origin: 'http://localhost:7878' };
const { mountDecksPanel } = await import('./decks-panel.js');

const walk = (el, out = []) => { out.push(el); for (const c of el.children || []) if (typeof c === 'object') walk(c, out); return out; };
const runtimesLine = (row) => walk(row).find((e) => e.className === 'deck-runtimes');
const chips = (line) => line.children.slice(1).map((c) => ({ text: c.textContent, title: c.title, off: c.className.includes('unavailable') }));

test('Settings › Decks shows each deck\'s offered runtimes, read-only, with why one cannot launch', () => {
  const root = mkEl('div');
  const decks = [
    { id: 'own', own: true, entry: { name: '' }, name: 'laptop', status: 'ready', descriptor: { offeredRuntimes: null, runtimes: [
      { id: 'local', label: 'Local (host)' }, { id: 'devcontainer', label: 'Devcontainer' },
      { id: 'testloc', label: 'Test location', location: true, unavailable: 'Mixed deck.' },
    ] } },
    { id: 'r1', entry: { url: 'http://127.0.0.1:7890', name: 'Location deck' }, name: 'Location deck', status: 'ready', descriptor: { offeredRuntimes: ['testloc'], runtimes: [
      { id: 'local', label: 'Local (host)', unavailable: 'Not offered.' },
      { id: 'testloc', label: 'Test location', location: true },
    ] } },
    { id: 'r2', entry: { url: 'http://127.0.0.1:7891' }, name: 'Down', status: 'unreachable', descriptor: null },
  ];
  mountDecksPanel(root, { decks: () => decks, change: async () => {}, toast() {} });
  const rows = root.children.filter((c) => c.className === 'deck-row');
  assert.equal(rows.length, 3);

  const own = runtimesLine(rows[0]);
  assert.equal(own.children[0].textContent, 'Runtimes (every runtime it has):');
  assert.deepEqual(chips(own), [
    { text: 'Local (host)', title: '', off: false },
    { text: 'Devcontainer', title: '', off: false },
    { text: 'Test location · location · unavailable', title: 'Mixed deck.', off: true },
  ]);

  const loc = runtimesLine(rows[1]);
  assert.equal(loc.children[0].textContent, 'Runtimes (set with --runtimes):');
  assert.deepEqual(chips(loc), [{ text: 'Test location · location', title: '', off: false }]);
  assert.equal(walk(rows[1]).some((e) => e.tagName === 'INPUT' && /runtime/i.test(e.attrs.ariaLabel || e.ariaLabel || '')), false, 'nothing to edit');

  assert.equal(runtimesLine(rows[2]), undefined, 'no descriptor, no runtimes line');
});
