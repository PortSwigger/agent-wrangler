import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checklistAddHandler, checklistUpdateHandler, checklistRemoveHandler, checklistReorderHandler,
} from './checklist.js';
import { routeControlMessage } from '../router.js';
import { ChecklistStore, MAX_TEXT_LENGTH } from '../../checklist-store.js';

function ctx() {
  const calls = { add: [], update: [], remove: [], reorder: [], rebuild: 0, replies: [] };
  return {
    calls,
    checklistStore: {
      add: (sessionId, text) => calls.add.push({ sessionId, text }),
      update: (sessionId, itemId, patch) => calls.update.push({ sessionId, itemId, patch }),
      remove: (sessionId, itemId) => calls.remove.push({ sessionId, itemId }),
      reorder: (sessionId, order) => calls.reorder.push({ sessionId, order }),
    },
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.replies.push(obj),
  };
}

function realCtx() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ck-handler-')), 'checklists.json');
  const calls = { rebuild: 0, replies: [] };
  return {
    calls,
    checklistStore: new ChecklistStore(file),
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.replies.push(obj),
  };
}

test('checklist-add adds to the given card id and rebuilds', async () => {
  const c = ctx();
  await checklistAddHandler.handler({ type: 'checklist-add', sessionId: 'CARD1', text: 'ship it' }, c);
  assert.deepEqual(c.calls.add, [{ sessionId: 'CARD1', text: 'ship it' }]);
  assert.equal(c.calls.rebuild, 1);
});

// Absent-vs-present is the whole contract: a checkbox click sends only `done`
// and must not blank the text; an inline rename sends only `text` and must not
// reset `done`.
test('checklist-update forwards ONLY the fields present on the message', async () => {
  const c = ctx();
  await checklistUpdateHandler.handler({ type: 'checklist-update', sessionId: 'CARD1', itemId: 'ck_1', done: true }, c);
  assert.deepEqual(c.calls.update.at(-1), { sessionId: 'CARD1', itemId: 'ck_1', patch: { done: true } });
  await checklistUpdateHandler.handler({ type: 'checklist-update', sessionId: 'CARD1', itemId: 'ck_1', text: 'new' }, c);
  assert.deepEqual(c.calls.update.at(-1), { sessionId: 'CARD1', itemId: 'ck_1', patch: { text: 'new' } });
  await checklistUpdateHandler.handler({ type: 'checklist-update', sessionId: 'CARD1', itemId: 'ck_1', text: 'x', done: false }, c);
  assert.deepEqual(c.calls.update.at(-1), { sessionId: 'CARD1', itemId: 'ck_1', patch: { text: 'x', done: false } });
  assert.equal(c.calls.rebuild, 3);
});

test('checklist-update forwards done:false as a real change, not an absent field', async () => {
  const c = ctx();
  await checklistUpdateHandler.handler({ type: 'checklist-update', sessionId: 'CARD1', itemId: 'ck_1', done: false }, c);
  assert.deepEqual(c.calls.update, [{ sessionId: 'CARD1', itemId: 'ck_1', patch: { done: false } }]);
});

test('checklist-remove removes and rebuilds', async () => {
  const c = ctx();
  await checklistRemoveHandler.handler({ type: 'checklist-remove', sessionId: 'CARD1', itemId: 'ck_1' }, c);
  assert.deepEqual(c.calls.remove, [{ sessionId: 'CARD1', itemId: 'ck_1' }]);
  assert.equal(c.calls.rebuild, 1);
});

test('checklist-reorder passes the order through, coercing a missing/garbage order to []', async () => {
  const c = ctx();
  await checklistReorderHandler.handler({ type: 'checklist-reorder', sessionId: 'CARD1', order: ['ck_2', 'ck_1'] }, c);
  assert.deepEqual(c.calls.reorder.at(-1), { sessionId: 'CARD1', order: ['ck_2', 'ck_1'] });
  await checklistReorderHandler.handler({ type: 'checklist-reorder', sessionId: 'CARD1' }, c);
  assert.deepEqual(c.calls.reorder.at(-1), { sessionId: 'CARD1', order: [] });
  await checklistReorderHandler.handler({ type: 'checklist-reorder', sessionId: 'CARD1', order: 'nope' }, c);
  assert.deepEqual(c.calls.reorder.at(-1), { sessionId: 'CARD1', order: [] });
});

test('the four types are routable end-to-end through the control router', async () => {
  const c = realCtx();
  await routeControlMessage(JSON.stringify({ type: 'checklist-add', sessionId: 'CARD1', text: 'one' }), c);
  await routeControlMessage(JSON.stringify({ type: 'checklist-add', sessionId: 'CARD1', text: 'two' }), c);
  const [a, b] = c.checklistStore.list('CARD1');
  await routeControlMessage(JSON.stringify({ type: 'checklist-update', sessionId: 'CARD1', itemId: a.id, done: true }), c);
  await routeControlMessage(JSON.stringify({ type: 'checklist-reorder', sessionId: 'CARD1', order: [b.id, a.id] }), c);
  assert.deepEqual(c.checklistStore.list('CARD1').map((i) => [i.text, i.done]), [['two', false], ['one', true]]);
  await routeControlMessage(JSON.stringify({ type: 'checklist-remove', sessionId: 'CARD1', itemId: b.id }), c);
  assert.deepEqual(c.checklistStore.list('CARD1').map((i) => i.text), ['one']);
  assert.deepEqual(c.calls.replies, [], 'no errors on the happy path');
});

// The store throws on a cap breach; the router's error envelope is what turns
// that into a toast rather than a silently dropped click.
test('a rejected add reaches the client as an error reply, not silence', async () => {
  const c = realCtx();
  await routeControlMessage(JSON.stringify({
    type: 'checklist-add', sessionId: 'CARD1', text: 'x'.repeat(MAX_TEXT_LENGTH + 1),
  }), c);
  assert.equal(c.calls.replies.length, 1);
  assert.equal(c.calls.replies[0].type, 'error');
  assert.match(c.calls.replies[0].message, /too long/);
  assert.deepEqual(c.checklistStore.list('CARD1'), []);
});
