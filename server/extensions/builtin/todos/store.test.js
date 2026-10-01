import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TodoStore, ADHOC } from './store.js';
import { tmpDir } from './test-helpers.js';

const tmpFile = () => path.join(tmpDir(), 'todos.json');
const texts = (store, bucket) => (store.snapshot().todos[bucket] || []).map((x) => x.text);

test('addTodo appends {id,text,createdAt} per bucket and persists with the migrated marker', () => {
  const file = tmpFile();
  const store = new TodoStore(file);
  const td = store.addTodo('t1', 'Wire the button', 1000);
  assert.match(td.id, /^td_[0-9a-f]{8}$/);
  assert.deepEqual({ text: td.text, createdAt: td.createdAt }, { text: 'Wire the button', createdAt: 1000 });
  store.addTodo('t1', 'Write the test', 2000);
  assert.deepEqual(texts(new TodoStore(file), 't1'), ['Wire the button', 'Write the test']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).migrated, true);
});

test('addTodo maps null to adhoc and rejects blank text', () => {
  const store = new TodoStore(tmpFile());
  assert.ok(store.addTodo(null, '  loose end  ', 1));
  assert.deepEqual(texts(store, ADHOC), ['loose end']);
  assert.equal(store.addTodo(ADHOC, '   '), null);
  assert.equal(store.addTodo(ADHOC, ''), null);
});

test('editTodo renames and edits descriptions; no-op on blank/unchanged/unknown', () => {
  const file = tmpFile();
  const store = new TodoStore(file);
  const td = store.addTodo('t1', 'old', 1, 'Found a race.');
  assert.equal(td.description, 'Found a race.');
  assert.equal(store.editTodo('t1', td.id, 'new'), true);
  assert.equal(store.editTodo('t1', td.id, 'new'), false);
  assert.equal(store.editTodo('t1', td.id, '  '), false);
  assert.equal(store.editTodo('t1', 'td_nope', 'x'), false);
  assert.equal(store.editTodo('t1', td.id), false);
  assert.equal(store.snapshot().todos.t1[0].description, 'Found a race.');
  assert.equal(store.editTodo('t1', td.id, undefined, ''), true);
  assert.equal(store.snapshot().todos.t1[0].description, undefined);
  assert.equal(new TodoStore(file).snapshot().todos.t1[0].text, 'new');
});

test('deleteTodo keeps the map sparse', () => {
  const store = new TodoStore(tmpFile());
  const a = store.addTodo('t1', 'a', 1);
  const b = store.addTodo('t1', 'b', 2);
  assert.equal(store.deleteTodo('t1', a.id), true);
  assert.equal(store.deleteTodo('t1', a.id), false);
  assert.equal(store.deleteTodo('t_nope', a.id), false);
  assert.equal(store.deleteTodo('t1', b.id), true);
  assert.equal(store.snapshot().todos.t1, undefined);
});

test('moveTodo reassigns across buckets, null means adhoc, same bucket is a no-op', () => {
  const file = tmpFile();
  const store = new TodoStore(file);
  const td = store.addTodo('a', 'shared', 7);
  assert.equal(store.moveTodo(td.id, 'a', 'b'), true);
  assert.equal(store.snapshot().todos.a, undefined);
  assert.equal(store.moveTodo(td.id, 'b', null), true);
  assert.equal(store.moveTodo(td.id, null, null), false);
  assert.equal(store.moveTodo('td_nope', ADHOC, 'a'), false);
  assert.deepEqual(new TodoStore(file).snapshot().todos[ADHOC].map((x) => x.id), [td.id]);
});

test('reorderTodos sets order, appends omitted ids, ignores unknown ids', () => {
  const store = new TodoStore(tmpFile());
  const a = store.addTodo('t1', 'a', 1);
  const b = store.addTodo('t1', 'b', 2);
  const c = store.addTodo('t1', 'c', 3);
  assert.equal(store.reorderTodos('t1', [c.id, a.id, b.id]), true);
  assert.equal(store.reorderTodos('t1', [c.id, a.id, b.id]), false);
  assert.equal(store.reorderTodos('t1', ['td_nope', b.id]), true);
  assert.deepEqual(texts(store, 't1'), ['b', 'c', 'a']);
  assert.equal(store.reorderTodos('t_nope', [a.id]), false);
  assert.equal(store.reorderTodos('t1', 'not-an-array'), false);
  store.addTodo(null, 'x', 1);
  const y = store.addTodo(null, 'y', 2);
  assert.equal(store.reorderTodos(null, [y.id]), true);
  assert.deepEqual(texts(store, ADHOC), ['y', 'x']);
});

test('snapshot is a deep copy', () => {
  const store = new TodoStore(tmpFile());
  store.addTodo('t1', 'a');
  const snap = store.snapshot();
  snap.todos.t1[0].text = 'mutated';
  snap.todos.t1.push({ id: 'td_x', text: 'extra', createdAt: 0 });
  assert.deepEqual(texts(store, 't1'), ['a']);
});

test('dropBucket removes a whole bucket and reports whether there was one', () => {
  const file = tmpFile();
  const store = new TodoStore(file);
  store.addTodo('t1', 'a');
  store.addTodo('t2', 'b');
  assert.equal(store.dropBucket('t1'), true);
  assert.equal(store.dropBucket('t1'), false);
  assert.deepEqual(Object.keys(new TodoStore(file).snapshot().todos), ['t2']);
});

test('prune drops buckets outside the valid set and saves only on change', () => {
  const file = tmpFile();
  const store = new TodoStore(file);
  store.addTodo('t1', 'keep');
  store.addTodo('t_gone', 'orphan');
  assert.equal(store.prune(new Set(['t1', ADHOC])), true);
  assert.deepEqual(Object.keys(store.snapshot().todos), ['t1']);
  fs.utimesSync(file, 1, 1);
  assert.equal(store.prune(new Set(['t1'])), false);
  assert.equal(fs.statSync(file).mtimeMs, 1000); // untouched by the no-op prune
});

test('load drops malformed buckets', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ migrated: true, todos: { t1: [{ id: 'td_1', text: 'ok', createdAt: 1 }], bad: 'nope', empty: [] } }));
  const store = new TodoStore(file);
  assert.equal(store.migrated, true);
  assert.deepEqual(Object.keys(store.snapshot().todos), ['t1']);
});
