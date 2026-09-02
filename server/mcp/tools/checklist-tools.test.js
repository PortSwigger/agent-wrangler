import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChecklistItemTool } from './add-checklist-item.js';
import { updateChecklistItemTool } from './update-checklist-item.js';
import { removeChecklistItemTool } from './remove-checklist-item.js';
import { listChecklistTool } from './list-checklist.js';
import { ChecklistStore, MAX_ITEMS, MAX_TEXT_LENGTH } from '../../checklist-store.js';
import { TOOLS, activeTools } from './index.js';
import { CHECKLIST_TOOLS } from '../client-config.js';

const TOOLS_BY_NAME = {
  add_checklist_item: addChecklistItemTool,
  update_checklist_item: updateChecklistItemTool,
  remove_checklist_item: removeChecklistItemTool,
  list_checklist: listChecklistTool,
};

function deps() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ck-tool-')), 'checklists.json');
  let rebuilds = 0;
  return { checklistStore: new ChecklistStore(file), rebuild: async () => { rebuilds++; }, rebuilds: () => rebuilds };
}

test('add_checklist_item writes to the CALLER\'s own session, resolved from identity', async () => {
  const d = deps();
  const out = await addChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { text: 'Ship the thing' });
  assert.match(out.structuredContent.id, /^ck_/);
  assert.deepEqual(d.checklistStore.list('CARD1').map((i) => i.text), ['Ship the thing']);
  assert.deepEqual(d.checklistStore.list('CARD2'), []);
  assert.equal(d.rebuilds(), 1, 'the board must re-render so the panel shows the new item');
});

// The whole point of caller-resolution: with a `session` parameter a launched
// agent could write into a sibling's checklist by hallucinating an id or lifting
// one off list_sessions. Assert the shape, not just the behaviour.
test('none of the four tools accepts a session parameter', () => {
  for (const [name, tool] of Object.entries(TOOLS_BY_NAME)) {
    const keys = Object.keys(tool.inputSchema || {});
    for (const forbidden of ['session', 'sessionId', 'session_id', 'card', 'cardId']) {
      assert.ok(!keys.includes(forbidden), `${name} must not take a ${forbidden} argument`);
    }
  }
});

test('a session argument smuggled in anyway is ignored — the caller still decides', async () => {
  const d = deps();
  await addChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { text: 'mine', session: 'CARD2', sessionId: 'CARD2' });
  assert.deepEqual(d.checklistStore.list('CARD1').map((i) => i.text), ['mine']);
  assert.deepEqual(d.checklistStore.list('CARD2'), []);
});

test('every tool refuses an identity-less caller', async () => {
  const d = deps();
  for (const [name, tool] of Object.entries(TOOLS_BY_NAME)) {
    const out = await tool.handler({ deps: d, caller: null }, { text: 'x', id: 'ck_1' });
    assert.equal(out.isError, true, `${name} must refuse a caller with no session identity`);
  }
});

test('add_checklist_item surfaces the store\'s cap breaches as a tool error, not a throw', async () => {
  const d = deps();
  const long = await addChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { text: 'x'.repeat(MAX_TEXT_LENGTH + 1) });
  assert.equal(long.isError, true);
  assert.match(long.content[0].text, /too long/);
  for (let i = 0; i < MAX_ITEMS; i++) d.checklistStore.add('CARD1', `item ${i}`);
  const full = await addChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { text: 'one more' });
  assert.equal(full.isError, true);
  assert.match(full.content[0].text, /full/);
});

test('add_checklist_item refuses blank text rather than silently doing nothing', async () => {
  const d = deps();
  const out = await addChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { text: '   ' });
  assert.equal(out.isError, true);
  assert.equal(d.rebuilds(), 0);
});

test('update_checklist_item patches only the fields passed', async () => {
  const d = deps();
  const { id } = d.checklistStore.add('CARD1', 'original', 1);
  await updateChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id, done: true });
  assert.deepEqual(d.checklistStore.list('CARD1'), [{ id, text: 'original', done: true, createdAt: 1 }]);
  await updateChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id, text: 'reworded' });
  assert.deepEqual(d.checklistStore.list('CARD1'), [{ id, text: 'reworded', done: true, createdAt: 1 }]);
});

test('update_checklist_item: no fields is an error; an unknown id is an error; an already-correct value is not', async () => {
  const d = deps();
  const { id } = d.checklistStore.add('CARD1', 'thing');
  assert.equal((await updateChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id })).isError, true);
  assert.equal((await updateChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id: 'ck_nope', done: true })).isError, true);
  const noop = await updateChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id, done: false });
  assert.equal(noop.isError, undefined);
  assert.equal(noop.structuredContent.changed, false);
});

test('update_checklist_item cannot reach another session\'s item', async () => {
  const d = deps();
  const { id } = d.checklistStore.add('OTHER', 'not yours');
  const out = await updateChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id, done: true });
  assert.equal(out.isError, true);
  assert.equal(d.checklistStore.list('OTHER')[0].done, false);
});

test('remove_checklist_item drops the caller\'s own item and errors on an unknown id', async () => {
  const d = deps();
  const { id } = d.checklistStore.add('CARD1', 'gone soon');
  const out = await removeChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id });
  assert.equal(out.structuredContent.removed, true);
  assert.deepEqual(d.checklistStore.list('CARD1'), []);
  assert.equal((await removeChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id })).isError, true);
});

test('remove_checklist_item cannot reach another session\'s item', async () => {
  const d = deps();
  const { id } = d.checklistStore.add('OTHER', 'not yours');
  assert.equal((await removeChecklistItemTool.handler({ deps: d, caller: 'CARD1' }, { id })).isError, true);
  assert.equal(d.checklistStore.list('OTHER').length, 1);
});

test('list_checklist returns the caller\'s own list, in order, and never a sibling\'s', async () => {
  const d = deps();
  d.checklistStore.add('CARD1', 'first', 1);
  d.checklistStore.add('CARD1', 'second', 2);
  d.checklistStore.add('OTHER', 'theirs', 3);
  const out = await listChecklistTool.handler({ deps: d, caller: 'CARD1' });
  assert.deepEqual(out.structuredContent.items.map((i) => i.text), ['first', 'second']);
  const theirs = await listChecklistTool.handler({ deps: d, caller: 'OTHER' });
  assert.deepEqual(theirs.structuredContent.items.map((i) => i.text), ['theirs']);
});

test('list_checklist takes no arguments at all', () => {
  assert.deepEqual(Object.keys(listChecklistTool.inputSchema), []);
});

// The description is the only place a launched agent learns this list is NOT its
// own planning tool. Losing that sentence is how the two silently converge.
test('every tool description says this is independent of the agent\'s own planning tool', () => {
  for (const [name, tool] of Object.entries(TOOLS_BY_NAME)) {
    assert.match(tool.description, /independent of|NOT your own|never synced/i, `${name}'s description must say so`);
    assert.match(tool.description, /no session parameter/i, `${name}'s description must say it has no session parameter`);
  }
});

test('activeTools drops exactly the four checklist tools when the feature is off', () => {
  const on = activeTools({ checklist: true }).map((t) => t.name);
  const off = activeTools({ checklist: false }).map((t) => t.name);
  assert.deepEqual(on, TOOLS.map((t) => t.name));
  for (const name of CHECKLIST_TOOLS) {
    assert.ok(on.includes(name), `${name} must be registered when the feature is on`);
    assert.ok(!off.includes(name), `${name} must NOT be registered when the feature is off`);
  }
  assert.equal(off.length, on.length - CHECKLIST_TOOLS.length, 'nothing else may be dropped');
});
