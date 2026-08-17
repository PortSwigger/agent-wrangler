import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskStore, ADHOC } from './task-store.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tasks-')), 'tasks.json');
}

// Render the display order as names (the Ad-hoc sentinel maps to itself).
function orderNames(store) {
  const snap = store.snapshot();
  const byId = new Map(snap.tasks.map((t) => [t.id, t.name]));
  return snap.order.map((id) => byId.get(id) || id);
}

test('createTask appends in order and persists', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const a = store.createTask({ name: 'Alpha' });
  store.createTask({ name: 'Beta' });
  assert.match(a.id, /^t_/);

  const reloaded = new TaskStore(file);
  const snap = reloaded.snapshot();
  assert.deepEqual(snap.tasks.map((t) => t.name), ['Alpha', 'Beta']);
  assert.equal(snap.tasks[0].slot, undefined);
  // New tasks append after the Ad-hoc tile, and the order persists across reload.
  assert.deepEqual(orderNames(reloaded), ['adhoc', 'Alpha', 'Beta']);
});

test('createTask seeds an assignment when given a sessionId', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Work', sessionId: 'sess-1' });
  assert.equal(store.snapshot().assignments['sess-1'], t.id);
});

test('createTask throws past the 19-task cap', () => {
  const store = new TaskStore(tmpFile());
  for (let i = 0; i < 19; i++) store.createTask({ name: `T${i}` });
  assert.throws(() => store.createTask({ name: 'Twentieth' }), /limit/i);
});

test('renameTask updates the name and is a no-op on blank/unchanged', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Old' });
  assert.equal(store.renameTask(t.id, 'New'), true);
  assert.equal(store.snapshot().tasks[0].name, 'New');
  assert.equal(store.renameTask(t.id, 'New'), false);
  assert.equal(new TaskStore(file).snapshot().tasks[0].name, 'New');
});

test('assign sets and clears a session→task mapping; unknown task ignored', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Work' });
  store.assign('sess-1', t.id);
  assert.equal(store.snapshot().assignments['sess-1'], t.id);
  store.assign('sess-1', null);
  assert.equal(store.snapshot().assignments['sess-1'], undefined);
  store.assign('sess-2', 't_nope');
  assert.equal(store.snapshot().assignments['sess-2'], undefined);
});

test('archiveTask stamps archivedAt; unarchiveTask clears it; both no-op when already in that state', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Work' });
  assert.equal(store.archiveTask(t.id, 1000), true);
  assert.equal(store.snapshot().tasks[0].archivedAt, 1000);
  assert.equal(store.archiveTask(t.id, 2000), false); // already archived
  assert.equal(store.snapshot().tasks[0].archivedAt, 1000); // unchanged

  assert.equal(store.unarchiveTask(t.id), true);
  assert.equal(store.snapshot().tasks[0].archivedAt, undefined);
  assert.equal(store.unarchiveTask(t.id), false); // not currently archived
});

test('archiveTask/unarchiveTask return false for an unknown id', () => {
  const store = new TaskStore(tmpFile());
  assert.equal(store.archiveTask('t_nope'), false);
  assert.equal(store.unarchiveTask('t_nope'), false);
});

test('archiveTask survives a reload', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Work' });
  store.archiveTask(t.id, 1000);

  const reloaded = new TaskStore(file);
  assert.equal(reloaded.snapshot().tasks[0].archivedAt, 1000);
});

test('archiveTask leaves assignments, sessionOrder, todos, links, and order untouched', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Work' });
  store.assign('s1', t.id);
  store.addTodo(t.id, 'do the thing');
  store.setLinks(t.id, [{ type: 'pr', url: 'https://x' }]);
  const before = store.snapshot();

  store.archiveTask(t.id);
  const after = store.snapshot();
  assert.deepEqual(after.assignments, before.assignments);
  assert.deepEqual(after.sessionOrder, before.sessionOrder);
  assert.deepEqual(after.todos, before.todos);
  assert.deepEqual(after.order, before.order);
  assert.deepEqual(store.getLinks(t.id), [{ type: 'pr', url: 'https://x' }]);
});

test('createTask counts only non-archived tasks against the cap', () => {
  const store = new TaskStore(tmpFile());
  for (let i = 0; i < 19; i++) store.createTask({ name: `T${i}` });
  const snap = store.snapshot();
  store.archiveTask(snap.tasks[0].id);
  // One archived → back under the cap, so a 20th (live) task is allowed.
  assert.doesNotThrow(() => store.createTask({ name: 'Fresh room' }));
  assert.throws(() => store.createTask({ name: 'Over again' }), /limit/i);
});

test('assign refuses an archived task, same as an unknown one', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Work' });
  store.archiveTask(t.id);
  assert.equal(store.assign('s1', t.id), false);
  assert.equal(store.snapshot().assignments['s1'], undefined);
});

test('reorderTask swaps two entries (tasks or the Ad-hoc sentinel)', () => {
  const store = new TaskStore(tmpFile());
  const a = store.createTask({ name: 'A' });
  const b = store.createTask({ name: 'B' });
  const c = store.createTask({ name: 'C' });
  assert.deepEqual(orderNames(store), ['adhoc', 'A', 'B', 'C']);
  // Swap A and C → [adhoc, C, B, A]
  store.reorderTask(a.id, c.id);
  assert.deepEqual(orderNames(store), ['adhoc', 'C', 'B', 'A']);
  // Ad hoc swaps like any tile: swap it with B → [B, C, adhoc, A]
  store.reorderTask(ADHOC, b.id);
  assert.deepEqual(orderNames(store), ['B', 'C', 'adhoc', 'A']);
  // No-ops: onto itself, null/missing target, unknown id
  assert.equal(store.reorderTask(b.id, b.id), false);
  assert.equal(store.reorderTask(a.id, null), false);
  assert.equal(store.reorderTask('t_nope', a.id), false);
});

test('reorderSession stores the supplied order; prunes on unassign', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Work' });
  store.assign('s1', t.id);
  store.assign('s2', t.id);
  store.assign('s3', t.id); // order: [s1, s2, s3]
  assert.deepEqual(store.snapshot().sessionOrder[t.id], ['s1', 's2', 's3']);

  // The supplied order is stored verbatim → [s3, s1, s2]
  assert.equal(store.reorderSession(t.id, ['s3', 's1', 's2']), true);
  assert.deepEqual(store.snapshot().sessionOrder[t.id], ['s3', 's1', 's2']);

  // Sessions not assigned to the task are filtered out
  store.reorderSession(t.id, ['s1', 's2', 's3', 'sX']);
  assert.deepEqual(store.snapshot().sessionOrder[t.id], ['s1', 's2', 's3']);

  // Persists across reload
  assert.deepEqual(new TaskStore(file).snapshot().sessionOrder[t.id], ['s1', 's2', 's3']);

  // Unknown bucket / no-op return false
  assert.equal(store.reorderSession('t_nope', ['s1']), false);
  assert.equal(store.reorderSession(t.id, ['s1', 's2', 's3']), false);

  // Unassign prunes from the order list
  store.unassign('s2');
  assert.deepEqual(store.snapshot().sessionOrder[t.id], ['s1', 's3']);

  // Reassigning elsewhere prunes from the old task's list
  const t2 = store.createTask({ name: 'Other' });
  store.assign('s1', t2.id);
  assert.deepEqual(store.snapshot().sessionOrder[t.id], ['s3']);
  assert.deepEqual(store.snapshot().sessionOrder[t2.id], ['s1']);
});

test('reorderSession orders the Ad-hoc bucket (unassigned sessions)', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Work' });
  store.assign('s2', t.id); // s1, s3 remain unassigned
  // Ad-hoc accepts unassigned sessions and filters out assigned ones
  assert.equal(store.reorderSession(ADHOC, ['s3', 's1', 's2']), true);
  assert.deepEqual(store.snapshot().sessionOrder[ADHOC], ['s3', 's1']);
  // Persists across reload
  assert.deepEqual(new TaskStore(file).snapshot().sessionOrder[ADHOC], ['s3', 's1']);
  // Assigning a previously-unassigned session prunes it from the Ad-hoc list
  store.assign('s3', t.id);
  assert.deepEqual(store.snapshot().sessionOrder[ADHOC], ['s1']);
});

test('bumpToEnd moves a session to the end of its bucket\'s stored order; persists; no-op when unordered/unknown', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Work' });
  store.assign('s1', t.id);
  store.assign('s2', t.id);
  store.assign('s3', t.id); // order: [s1, s2, s3]

  assert.equal(store.bumpToEnd('s1'), true);
  assert.deepEqual(store.snapshot().sessionOrder[t.id], ['s2', 's3', 's1']);
  // Persists across reload
  assert.deepEqual(new TaskStore(file).snapshot().sessionOrder[t.id], ['s2', 's3', 's1']);

  // Already at the end: still true, order unchanged
  assert.equal(store.bumpToEnd('s1'), true);
  assert.deepEqual(store.snapshot().sessionOrder[t.id], ['s2', 's3', 's1']);

  // A session with no explicit order in its bucket (e.g. never-dragged Ad-hoc) is a no-op
  assert.equal(store.bumpToEnd('s_unassigned'), false);

  // An unknown session id is a no-op
  assert.equal(store.bumpToEnd('s_nope'), false);
});

test('loads and migrates the old slot-based format, preserving order', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      tasks: [
        { id: 't_2', name: 'Second', slot: 5 },
        { id: 't_1', name: 'First', slot: 0 },
      ],
      assignments: { 'sess-1': 't_1' },
      noTaskSlot: 8,
    })
  );
  const store = new TaskStore(file);
  const snap = store.snapshot();
  assert.deepEqual(snap.tasks.map((t) => t.name), ['First', 'Second']);
  assert.equal(snap.tasks[0].slot, undefined);
  assert.equal(snap.assignments['sess-1'], 't_1');
  // No stored order → reconciled to tasks-then-Ad-hoc (the old pinned position).
  assert.deepEqual(orderNames(store), ['First', 'Second', 'adhoc']);
});

test('taskFor returns the assigned task {id,name}, or null when unassigned/unknown', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Alpha', sessionId: 's1' });
  assert.deepEqual(store.taskFor('s1'), { id: t.id, name: 'Alpha' });
  assert.equal(store.taskFor('s2'), null);
  store.unassign('s1');
  assert.equal(store.taskFor('s1'), null);
});

test('isAssignedToArchivedTask: true only for an assignment to a currently-archived task', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Alpha', sessionId: 's1' });
  // Live task: false.
  assert.equal(store.isAssignedToArchivedTask('s1'), false);
  // Unassigned session: false.
  assert.equal(store.isAssignedToArchivedTask('nobody'), false);
  store.archiveTask(t.id);
  assert.equal(store.isAssignedToArchivedTask('s1'), true);
  store.unarchiveTask(t.id);
  assert.equal(store.isAssignedToArchivedTask('s1'), false);
});

test('task links default to empty and round-trip via set/getLinks', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Login' });
  assert.deepEqual(store.getLinks(t.id), []);
  const links = [{ type: 'jira', key: 'ENT-1', url: 'https://x/ENT-1' }];
  assert.equal(store.setLinks(t.id, links), true);
  assert.deepEqual(store.getLinks(t.id), links);
});

test('setLinks replaces the whole list and persists across reload', () => {
  const f = tmpFile();
  const store = new TaskStore(f);
  const t = store.createTask({ name: 'Login' });
  store.setLinks(t.id, [{ type: 'jira', key: 'ENT-1' }]);
  store.setLinks(t.id, [{ type: 'jira', key: 'ENT-2' }]);
  const reloaded = new TaskStore(f);
  assert.deepEqual(reloaded.getLinks(t.id), [{ type: 'jira', key: 'ENT-2' }]);
});

test('setLinks/getLinks on an unknown task id are safe', () => {
  const store = new TaskStore(tmpFile());
  assert.equal(store.setLinks('nope', []), false);
  assert.deepEqual(store.getLinks('nope'), []);
});

test('prLinks lists pr links with their task id', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Login' });
  store.setLinks(t.id, [
    { type: 'jira', key: 'ENT-1' },
    { type: 'pr', url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1 },
  ]);
  assert.deepEqual(store.prLinks(), [{ ownerId: t.id, url: 'https://github.com/a/b/pull/1', number: 1, checkStatus: undefined, dirty: undefined, unresolvedCount: undefined }]);
});

test('updateLinkStatus writes checkStatus/dirty onto the matching pr link only', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Login' });
  store.setLinks(t.id, [
    { type: 'jira', key: 'ENT-1' },
    { type: 'pr', url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1 },
  ]);
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'passing', true, '2026-06-16T00:00:00Z'), true);
  const links = store.getLinks(t.id);
  assert.equal(links.find((l) => l.type === 'pr').checkStatus, 'passing');
  assert.equal(links.find((l) => l.type === 'pr').dirty, true);
  assert.equal(links.find((l) => l.type === 'jira').checkStatus, undefined);
});

test('updateLinkStatus is a no-op for an unknown task or url', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Login' });
  store.setLinks(t.id, [{ type: 'pr', url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1 }]);
  assert.equal(store.updateLinkStatus('nope', 'https://github.com/a/b/pull/1', 'passing', false, 'x'), false);
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/999', 'passing', false, 'x'), false);
});

test('updateLinkStatus returns false when checkStatus AND dirty are unchanged (but still refreshes the timestamp)', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Login' });
  store.setLinks(t.id, [{ type: 'pr', url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1 }]);
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'passing', false, '2026-06-16T00:00:00Z'), true);
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'passing', false, '2026-06-16T01:00:00Z'), false);
  const link = store.getLinks(t.id).find((l) => l.type === 'pr');
  assert.equal(link.checkStatus, 'passing');
  assert.equal(link.checkStatusFetchedAt, '2026-06-16T01:00:00Z');
});

test('updateLinkStatus returns true when only dirty changes (checkStatus stable)', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Login' });
  store.setLinks(t.id, [{ type: 'pr', url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1 }]);
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'pending', false, 'x'), true);
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'pending', true, 'y'), true);
});

test('updateLinkStatus writes unresolvedCount as the last param and reports it in the changed check', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Login' });
  store.setLinks(t.id, [{ type: 'pr', url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1 }]);
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'pending', false, 'x', 2), true);
  assert.equal(store.getLinks(t.id).find((l) => l.type === 'pr').unresolvedCount, 2);
  // same checkStatus/dirty, unresolvedCount alone changes -> still reported changed
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'pending', false, 'y', 5), true);
  // everything stable -> no change
  assert.equal(store.updateLinkStatus(t.id, 'https://github.com/a/b/pull/1', 'pending', false, 'z', 5), false);
});

// ── TODOs ──────────────────────────────────────────────────────────────────────

test('addTodo appends {id,text,createdAt} per task and persists', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Work' });
  const td = store.addTodo(t.id, 'Wire the button', 1000);
  assert.match(td.id, /^td_/);
  assert.equal(td.text, 'Wire the button');
  assert.equal(td.createdAt, 1000);
  store.addTodo(t.id, 'Write the test', 2000);
  assert.deepEqual(new TaskStore(file).snapshot().todos[t.id].map((x) => x.text), ['Wire the button', 'Write the test']);
});

test('addTodo accepts the adhoc bucket (string or null) and rejects blank text', () => {
  const store = new TaskStore(tmpFile());
  const td = store.addTodo(ADHOC, '  Jot this down  ', 1);
  assert.equal(td.text, 'Jot this down');
  assert.deepEqual(store.snapshot().todos[ADHOC].map((x) => x.text), ['Jot this down']);
  // null is the wire form the handlers send for the unassigned tile
  const td2 = store.addTodo(null, 'loose end', 2);
  assert.equal(td2.text, 'loose end');
  assert.deepEqual(store.snapshot().todos[ADHOC].map((x) => x.text), ['Jot this down', 'loose end']);
  assert.equal(store.addTodo(ADHOC, '   '), null);
  assert.equal(store.addTodo(ADHOC, ''), null);
});

test('addTodo rejects an unknown task id', () => {
  const store = new TaskStore(tmpFile());
  assert.equal(store.addTodo('t_nope', 'x'), null);
});

test('editTodo renames in place; no-op on blank/unchanged/unknown', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Work' });
  const td = store.addTodo(t.id, 'old', 1);
  assert.equal(store.editTodo(t.id, td.id, 'new'), true);
  assert.equal(store.snapshot().todos[t.id][0].text, 'new');
  assert.equal(store.editTodo(t.id, td.id, 'new'), false);
  assert.equal(store.editTodo(t.id, td.id, '  '), false);
  assert.equal(store.editTodo(t.id, 'td_nope', 'x'), false);
  assert.equal(store.editTodo('t_nope', td.id, 'x'), false);
  assert.equal(new TaskStore(file).snapshot().todos[t.id][0].text, 'new');
});

test('deleteTodo removes a todo; keeps map sparse (deletes key when empty); no-op on unknown', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Work' });
  const a = store.addTodo(t.id, 'a', 1);
  const b = store.addTodo(t.id, 'b', 2);
  assert.equal(store.deleteTodo(t.id, a.id), true);
  assert.deepEqual(store.snapshot().todos[t.id].map((x) => x.text), ['b']);
  assert.equal(store.deleteTodo(t.id, a.id), false);
  assert.equal(store.deleteTodo('t_nope', a.id), false);
  assert.equal(store.deleteTodo(t.id, b.id), true);
  assert.equal(store.snapshot().todos[t.id], undefined);
});

test('moveTodo reassigns across buckets; keeps map sparse; no-op for same/unknown', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const a = store.createTask({ name: 'A' });
  const b = store.createTask({ name: 'B' });
  const td = store.addTodo(a.id, 'shared work', 7);
  assert.equal(store.moveTodo(td.id, a.id, b.id), true);
  assert.equal(store.snapshot().todos[a.id], undefined);
  assert.deepEqual(store.snapshot().todos[b.id].map((x) => x.text), ['shared work']);
  assert.equal(store.moveTodo(td.id, b.id, null), true); // null wire form → ADHOC
  assert.deepEqual(store.snapshot().todos[ADHOC].map((x) => x.id), [td.id]);
  assert.equal(store.moveTodo(td.id, null, null), false); // same bucket (both → ADHOC)
  assert.equal(store.moveTodo('td_nope', ADHOC, a.id), false);
  assert.equal(store.moveTodo(td.id, ADHOC, 't_nope'), false);
  assert.deepEqual(new TaskStore(file).snapshot().todos[ADHOC].map((x) => x.id), [td.id]);
});

test('snapshot().todos is a deep copy (mutating it does not mutate the store)', () => {
  const store = new TaskStore(tmpFile());
  const t = store.createTask({ name: 'Work' });
  const td = store.addTodo(t.id, 'a');
  const snap = store.snapshot();
  snap.todos[t.id][0].text = 'mutated';
  snap.todos[t.id].push({ id: 'td_x', text: 'extra', createdAt: 0 });
  const fresh = store.snapshot();
  assert.equal(fresh.todos[t.id][0].text, 'a');
  assert.equal(fresh.todos[t.id].length, 1);
});

test('load drops todos for unknown buckets', () => {
  const file = tmpFile();
  const store = new TaskStore(file);
  const t = store.createTask({ name: 'Work' });
  store.addTodo(t.id, 'keep', 1);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.todos['t_gone'] = [{ id: 'td_x', text: 'orphan', createdAt: 9 }];
  fs.writeFileSync(file, JSON.stringify(raw));
  const reloaded = new TaskStore(file);
  assert.deepEqual(Object.keys(reloaded.snapshot().todos), [t.id]);
});
