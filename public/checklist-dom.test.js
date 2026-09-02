import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChecklistDom, checklistCountLabel } from './checklist-dom.js';

// A DOM stub sufficient for the reconciliation assertions: no jsdom, matching how
// the rest of public/ stays DOM-free. It tracks innerHTML writes so the
// "never innerHTML" rule can be asserted rather than merely commented.
function stubDocument() {
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      className: '',
      dataset: {},
      attrs: {},
      _text: null,
      _html: null,
      scrollTop: 0,
      get firstChild() { return this.children[0] || null; },
      appendChild(c) { this.children.push(c); c.parent = el; return c; },
      insertBefore(node, ref) {
        const from = this.children.indexOf(node);
        if (from >= 0) this.children.splice(from, 1);
        const at = ref ? this.children.indexOf(ref) : -1;
        if (at < 0) this.children.push(node);
        else this.children.splice(at, 0, node);
        node.parent = el;
        return node;
      },
      removeChild(node) {
        const at = this.children.indexOf(node);
        if (at >= 0) this.children.splice(at, 1);
        return node;
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      querySelector(sel) {
        const cls = sel.replace('.', '');
        for (const n of walk(el)) if (n !== el && String(n.className).split(' ').includes(cls)) return n;
        return null;
      },
      set textContent(v) { this._text = v; },
      get textContent() { return this._text; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
    };
    return el;
  };
  return { createElement: make };
}

const walk = (node, out = []) => {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
};

const listStub = () => stubDocument().createElement('div');
const textsOf = (list) => list.children.map((r) => r.querySelector('.ck-text').textContent);
const idsOf = (list) => list.children.map((r) => r.dataset.ckid);

function dom() {
  return createChecklistDom({ document: stubDocument() });
}

test('item text goes in via textContent and never reaches innerHTML', () => {
  const list = listStub();
  dom().patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: '<img src=x onerror=alert(1)>', done: false }] });
  const row = list.children[0];
  assert.equal(row.querySelector('.ck-text').textContent, '<img src=x onerror=alert(1)>');
  // Nothing in the rendered subtree — the list included — ever took an
  // innerHTML write. Item text is agent-written, so this is the rule.
  for (const node of walk(list)) assert.equal(node._html, null, `${node.className} must not use innerHTML`);
});

test('patch reuses the SAME row elements across a re-render (the poll tick)', () => {
  const d = dom();
  const list = listStub();
  const items = [{ id: 'ck_1', text: 'a', done: false }, { id: 'ck_2', text: 'b', done: false }];
  d.patch(list, { sessionId: 'CARD1', items });
  const before = [...list.children];
  list.scrollTop = 120; // a human scrolled into the list
  d.patch(list, { sessionId: 'CARD1', items });
  assert.deepEqual([...list.children], before, 'rows must be the same element instances');
  assert.equal(list.scrollTop, 120, 'a re-render must not reset scroll');
});

test('patch does not rewrite a row whose text and done state are unchanged', () => {
  const d = dom();
  const list = listStub();
  const items = [{ id: 'ck_1', text: 'a', done: true }];
  d.patch(list, { sessionId: 'CARD1', items });
  const text = list.children[0].querySelector('.ck-text');
  let writes = 0;
  const raw = text._text;
  Object.defineProperty(text, 'textContent', { get: () => raw, set: () => { writes++; } });
  d.patch(list, { sessionId: 'CARD1', items });
  assert.equal(writes, 0, 'an unchanged row must take no textContent write (it would drop a selection)');
});

test('patch adds, updates and removes without touching unrelated rows', () => {
  const d = dom();
  const list = listStub();
  d.patch(list, {
    sessionId: 'CARD1',
    items: [{ id: 'ck_1', text: 'a', done: false }, { id: 'ck_2', text: 'b', done: false }],
  });
  const keptRow = list.children[0];
  d.patch(list, {
    sessionId: 'CARD1',
    items: [
      { id: 'ck_1', text: 'a', done: false },
      { id: 'ck_3', text: 'c', done: true },
    ],
  });
  assert.deepEqual(idsOf(list), ['ck_1', 'ck_3']);
  assert.equal(list.children[0], keptRow, 'the surviving row is the same element');
  assert.equal(list.children[1].className, 'ck-row done');
  assert.equal(list.children[1].querySelector('.ck-check').getAttribute('aria-checked'), 'true');
});

test('a reorder moves the existing elements rather than rebuilding them', () => {
  const d = dom();
  const list = listStub();
  const a = { id: 'ck_1', text: 'a', done: false };
  const b = { id: 'ck_2', text: 'b', done: false };
  const c = { id: 'ck_3', text: 'c', done: false };
  d.patch(list, { sessionId: 'CARD1', items: [a, b, c] });
  const [rowA, rowB, rowC] = list.children;
  d.patch(list, { sessionId: 'CARD1', items: [c, a, b] });
  assert.deepEqual(textsOf(list), ['c', 'a', 'b']);
  assert.deepEqual([...list.children], [rowC, rowA, rowB]);
});

test('toggling done in place keeps the row element and flips its state', () => {
  const d = dom();
  const list = listStub();
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'a', done: false }] });
  const row = list.children[0];
  assert.equal(row.className, 'ck-row');
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'a', done: true }] });
  assert.equal(list.children[0], row);
  assert.equal(row.className, 'ck-row done');
  assert.equal(row.querySelector('.ck-check').getAttribute('aria-checked'), 'true');
});

test('switching session empties the list instead of diffing against another card ids', () => {
  const d = dom();
  const list = listStub();
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'mine', done: false }] });
  d.patch(list, { sessionId: 'CARD2', items: [{ id: 'ck_9', text: 'theirs', done: false }] });
  assert.deepEqual(textsOf(list), ['theirs']);
  assert.equal(list.dataset.sid, 'CARD2');
});

test('an empty checklist renders no rows (the panel keeps its + Add affordance)', () => {
  const d = dom();
  const list = listStub();
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'a', done: false }] });
  assert.equal(d.patch(list, { sessionId: 'CARD1', items: [] }), 0);
  assert.deepEqual(list.children, []);
});

test('every row carries the id and the drag handle the reorder gesture needs', () => {
  const list = listStub();
  dom().patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'a', done: false }] });
  assert.equal(list.children[0].dataset.ckid, 'ck_1');
  assert.equal(list.children[0].getAttribute('draggable'), 'true');
});

test('checklistCountLabel summarises progress, and is empty for an empty list', () => {
  assert.equal(checklistCountLabel([]), '');
  assert.equal(checklistCountLabel(), '');
  assert.equal(checklistCountLabel([{ done: false }, { done: true }, { done: true }]), '2/3 done');
});
