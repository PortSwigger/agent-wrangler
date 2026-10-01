import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChecklistStore, MAX_ITEMS, MAX_TEXT_LENGTH } from './checklist-store.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-checklist-')), 'checklists.json');
}

test('add: appends an item keyed on the card id, with done false', () => {
  const store = new ChecklistStore(tmpFile());
  const item = store.add('CARD1', 'Read the spec', 111);
  assert.equal(item.text, 'Read the spec');
  assert.equal(item.done, false);
  assert.equal(item.createdAt, 111);
  assert.match(item.id, /^ck_[0-9a-f]{8}$/);
  assert.deepEqual(store.list('CARD1'), [item]);
  // A different card id is a different list — never shared, never merged.
  assert.deepEqual(store.list('CARD2'), []);
});

test('add: trims, and a blank text is a silent no-op (matches addTodo)', () => {
  const store = new ChecklistStore(tmpFile());
  assert.equal(store.add('CARD1', '   '), null);
  assert.equal(store.add('CARD1', ''), null);
  assert.equal(store.add('CARD1', undefined), null);
  assert.deepEqual(store.list('CARD1'), []);
  assert.equal(store.add('CARD1', '  padded  ').text, 'padded');
});

test('add: rejects over-long text and a full list BEFORE appending anything', () => {
  const store = new ChecklistStore(tmpFile());
  assert.throws(() => store.add('CARD1', 'x'.repeat(MAX_TEXT_LENGTH + 1)), /too long/);
  assert.deepEqual(store.list('CARD1'), []);
  for (let i = 0; i < MAX_ITEMS; i++) store.add('CARD1', `item ${i}`);
  assert.throws(() => store.add('CARD1', 'one too many'), /full/);
  assert.equal(store.list('CARD1').length, MAX_ITEMS);
});

test('update: patches text and done independently, leaving the other field alone', () => {
  const store = new ChecklistStore(tmpFile());
  const { id } = store.add('CARD1', 'original', 1);
  assert.equal(store.update('CARD1', id, { done: true }), true);
  assert.deepEqual(store.list('CARD1'), [{ id, text: 'original', done: true, createdAt: 1 }]);
  assert.equal(store.update('CARD1', id, { text: 'renamed' }), true);
  assert.deepEqual(store.list('CARD1'), [{ id, text: 'renamed', done: true, createdAt: 1 }]);
  assert.equal(store.update('CARD1', id, { done: false, text: 'both' }), true);
  assert.deepEqual(store.list('CARD1'), [{ id, text: 'both', done: false, createdAt: 1 }]);
});

test('update: no-ops return false; unknown session/item returns false', () => {
  const store = new ChecklistStore(tmpFile());
  const { id } = store.add('CARD1', 'thing');
  assert.equal(store.update('CARD1', id, {}), false);
  assert.equal(store.update('CARD1', id, { text: 'thing' }), false);
  assert.equal(store.update('CARD1', id, { done: false }), false);
  // Blank text is ignored rather than blanking the item.
  assert.equal(store.update('CARD1', id, { text: '  ' }), false);
  assert.equal(store.list('CARD1')[0].text, 'thing');
  assert.equal(store.update('CARD1', 'ck_nope', { done: true }), false);
  assert.equal(store.update('NOSUCH', id, { done: true }), false);
});

test('update: rejects over-long text without touching the item', () => {
  const store = new ChecklistStore(tmpFile());
  const { id } = store.add('CARD1', 'short');
  assert.throws(() => store.update('CARD1', id, { text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }), /too long/);
  assert.equal(store.list('CARD1')[0].text, 'short');
});

test('remove: drops one item and keeps the map sparse once the list empties', () => {
  const file = tmpFile();
  const store = new ChecklistStore(file);
  const a = store.add('CARD1', 'a');
  const b = store.add('CARD1', 'b');
  assert.equal(store.remove('CARD1', a.id), true);
  assert.deepEqual(store.list('CARD1').map((i) => i.text), ['b']);
  assert.equal(store.remove('CARD1', a.id), false);
  assert.equal(store.remove('CARD1', b.id), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});

test('reorder: applies the given order and APPENDS anything omitted (never deletes by omission)', () => {
  const store = new ChecklistStore(tmpFile());
  const a = store.add('CARD1', 'a');
  const b = store.add('CARD1', 'b');
  const c = store.add('CARD1', 'c');
  assert.equal(store.reorder('CARD1', [c.id, a.id, b.id]), true);
  assert.deepEqual(store.list('CARD1').map((i) => i.text), ['c', 'a', 'b']);
  // A stale client that omits an id must not lose it.
  assert.equal(store.reorder('CARD1', [b.id]), true);
  assert.deepEqual(store.list('CARD1').map((i) => i.text), ['b', 'c', 'a']);
  // Unknown ids and duplicates are ignored, not errors.
  assert.equal(store.reorder('CARD1', [a.id, a.id, 'ck_nope', b.id, c.id]), true);
  assert.deepEqual(store.list('CARD1').map((i) => i.text), ['a', 'b', 'c']);
  assert.equal(store.reorder('CARD1', [a.id, b.id, c.id]), false); // already in that order
  assert.equal(store.reorder('NOSUCH', [a.id]), false);
  assert.equal(store.reorder('CARD1', 'nope'), false);
});

test('list/snapshot hand back copies — mutating them cannot reach the store', () => {
  const store = new ChecklistStore(tmpFile());
  store.add('CARD1', 'a');
  const listed = store.list('CARD1');
  listed[0].text = 'tampered';
  listed.push({ id: 'ck_x', text: 'injected', done: false, createdAt: 0 });
  const snap = store.snapshot();
  snap.CARD1[0].done = true;
  assert.deepEqual(store.list('CARD1').map((i) => [i.text, i.done]), [['a', false]]);
});

test('snapshot: the whole store, keyed by card id, ready to ride the graph', () => {
  const store = new ChecklistStore(tmpFile());
  const a = store.add('CARD1', 'first', 1);
  const b = store.add('CARD2', 'other', 2);
  assert.deepEqual(store.snapshot(), { CARD1: [a], CARD2: [b] });
});

test('every mutator runs to completion synchronously — nothing returns a promise', () => {
  // The whole point of the store's shape: the human (control WS) and the agent
  // (MCP) both write, and an await between a read and its write is where one
  // would clobber the other. A mutator that ever became async would silently
  // reopen that window, so assert it here rather than in a comment.
  const store = new ChecklistStore(tmpFile());
  const { id } = store.add('CARD1', 'a');
  for (const result of [
    store.add('CARD1', 'b'),
    store.update('CARD1', id, { done: true }),
    store.reorder('CARD1', [id]),
    store.remove('CARD1', id),
    store.forget('CARD1'),
  ]) {
    assert.equal(typeof result?.then, 'undefined');
  }
});

test('forget: drops the whole list — the purge path, never archive', () => {
  const store = new ChecklistStore(tmpFile());
  store.add('CARD1', 'a');
  store.add('CARD2', 'b');
  store.forget('CARD1');
  assert.deepEqual(store.list('CARD1'), []);
  assert.deepEqual(store.list('CARD2').map((i) => i.text), ['b']);
});

test('persists across instances (a resume/restart restores the same list)', () => {
  const file = tmpFile();
  const first = new ChecklistStore(file);
  const a = first.add('CARD1', 'survive me', 7);
  first.update('CARD1', a.id, { done: true });
  const second = new ChecklistStore(file);
  assert.deepEqual(second.list('CARD1'), [{ id: a.id, text: 'survive me', done: true, createdAt: 7 }]);
});

test('a garbage entry on disk is skipped rather than crashing the load', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ CARD1: 'not-an-array', CARD2: [{ id: 'ck_1', text: 'ok' }] }));
  const store = new ChecklistStore(file);
  assert.deepEqual(store.list('CARD1'), []);
  assert.deepEqual(store.list('CARD2'), [{ id: 'ck_1', text: 'ok', done: false, createdAt: null }]);
});
