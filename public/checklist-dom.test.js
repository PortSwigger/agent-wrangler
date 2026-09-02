import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChecklistDom, checklistCountLabel, checklistPillLabel, isPendingChecklistId,
  shouldShowChecklistPill, isChecklistOpen, toggleChecklistOpen, parseChecklistOpen,
  serializeChecklistOpen,
} from './checklist-dom.js';

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

test('isPendingChecklistId spots the optimistic local id and nothing else', () => {
  assert.equal(isPendingChecklistId('tmp_1788379691136'), true);
  assert.equal(isPendingChecklistId('ck_eb25e7eb'), false);
  assert.equal(isPendingChecklistId(undefined), false);
  assert.equal(isPendingChecklistId(null), false);
});

// An optimistically-added item has no server-known id yet, so a toggle, rename,
// delete or reorder aimed at it would be rejected server-side while applying
// locally — and the next graph would silently revert it. The row therefore
// renders inert (and undraggable) rather than as live controls.
test('an optimistic tmp_ row is marked pending and is not draggable', () => {
  const d = dom();
  const list = listStub();
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'tmp_1', text: 'just typed', done: false }] });
  const row = list.children[0];
  assert.equal(row.className, 'ck-row pending');
  assert.equal(row.getAttribute('draggable'), 'false');
});

test('once the server echo replaces the tmp id, the row is a normal draggable row', () => {
  const d = dom();
  const list = listStub();
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'tmp_1', text: 'just typed', done: false }] });
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_real', text: 'just typed', done: false }] });
  const row = list.children[0];
  assert.equal(row.className, 'ck-row');
  assert.equal(row.getAttribute('draggable'), 'true');
  assert.equal(list.children.length, 1, 'the tmp row is replaced, not left alongside');
});

test('checklistPillLabel reads done/total', () => {
  assert.equal(checklistPillLabel([{ done: false }, { done: true }, { done: true }]), '2/3');
  // Defensive only — shouldShowChecklistPill means an empty list renders no chip.
  assert.equal(checklistPillLabel([]), '0/0');
  assert.equal(checklistPillLabel(), '0/0');
});

// A session not using the checklist must cost no chrome at all: no chip in the
// meta row and no panel. Starting one is the Actions menu's "New checklist item".
test('no chip for a session with no items', () => {
  assert.equal(shouldShowChecklistPill([], false), false);
  assert.equal(shouldShowChecklistPill(undefined, undefined), false);
});

test('one item is enough to earn a chip', () => {
  assert.equal(shouldShowChecklistPill([{ done: false }], false), true);
  assert.equal(shouldShowChecklistPill([{ done: true }], false), true);
});

// Deleting the last item while the panel is open must not strand it: the chip is
// the only control that can collapse the panel, so it survives an empty list for
// exactly as long as the panel is open.
test('an open panel keeps its chip even once the last item is deleted', () => {
  assert.equal(shouldShowChecklistPill([], true), true);
  // Collapse it and both vanish together.
  assert.equal(shouldShowChecklistPill([], false), false);
});

test('a session starts COLLAPSED — nothing remembered means the panel costs no height', () => {
  const overrides = new Map();
  assert.equal(isChecklistOpen(overrides, 'CARD1'), false);
  assert.equal(isChecklistOpen(overrides, undefined), false);
  assert.equal(isChecklistOpen(overrides, null), false);
});

test('toggling is per session — one session opening never opens another', () => {
  const overrides = new Map();
  toggleChecklistOpen(overrides, 'CARD1');
  assert.equal(isChecklistOpen(overrides, 'CARD1'), true);
  assert.equal(isChecklistOpen(overrides, 'CARD2'), false, "a sibling session stays collapsed");
  toggleChecklistOpen(overrides, 'CARD1');
  assert.equal(isChecklistOpen(overrides, 'CARD1'), false, 'toggling again collapses it');
  // An explicit "closed" is remembered as such, not as "never touched" — both
  // read collapsed today, but the distinction is what a future
  // expanded-by-default setting would need, and matches the sub-agents map.
  assert.equal(overrides.get('CARD1'), false);
});

test('toggling with no session selected is a no-op rather than an undefined key', () => {
  const overrides = new Map();
  toggleChecklistOpen(overrides, null);
  assert.equal(overrides.size, 0);
});

test('the open/collapsed choice survives a reload (serialize → parse round trip)', () => {
  const overrides = new Map();
  toggleChecklistOpen(overrides, 'CARD1');           // open
  toggleChecklistOpen(overrides, 'CARD2');           // open
  toggleChecklistOpen(overrides, 'CARD2');           // and closed again
  const restored = parseChecklistOpen(serializeChecklistOpen(overrides));
  assert.equal(isChecklistOpen(restored, 'CARD1'), true);
  assert.equal(isChecklistOpen(restored, 'CARD2'), false);
  assert.equal(isChecklistOpen(restored, 'CARD3'), false);
});

// Collapsed is the safe direction to fail towards: it costs the terminal no
// height, so anything unreadable on disk reads as "every session collapsed"
// rather than leaving a session stuck open.
test('parseChecklistOpen tolerates junk, missing and legacy values as all-collapsed', () => {
  for (const raw of [null, undefined, '', 'not json', '[]', '["CARD1"]', '42', '"CARD1"', 'null']) {
    assert.deepEqual([...parseChecklistOpen(raw)], [], `${JSON.stringify(raw)} must read as nothing remembered`);
  }
  // A non-boolean value is dropped, not coerced — a garbage entry can't pin a
  // session open.
  const mixed = parseChecklistOpen(JSON.stringify({ CARD1: true, CARD2: 'yes', CARD3: 1 }));
  assert.deepEqual([...mixed], [['CARD1', true]]);
});

// Without these the row's two controls are a bare glyph and a bare ×, so every
// row reads identically to a screen reader; and the single ellipsised line makes
// a long item's tail unrecoverable without entering edit mode.
test('a row names itself: item text becomes the controls\' accessible name and the text\'s title', () => {
  const list = listStub();
  dom().patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'Migrate the auth middleware', done: false }] });
  const row = list.children[0];
  assert.equal(row.querySelector('.ck-text').getAttribute('title'), 'Migrate the auth middleware');
  assert.equal(row.querySelector('.ck-check').getAttribute('aria-label'), 'Migrate the auth middleware');
  assert.equal(row.querySelector('.ck-del').getAttribute('aria-label'), 'Delete: Migrate the auth middleware');
});

test('renaming an item re-labels its controls too, so they never name the old text', () => {
  const d = dom();
  const list = listStub();
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'before', done: false }] });
  d.patch(list, { sessionId: 'CARD1', items: [{ id: 'ck_1', text: 'after', done: false }] });
  const row = list.children[0];
  assert.equal(row.querySelector('.ck-text').getAttribute('title'), 'after');
  assert.equal(row.querySelector('.ck-check').getAttribute('aria-label'), 'after');
  assert.equal(row.querySelector('.ck-del').getAttribute('aria-label'), 'Delete: after');
});
