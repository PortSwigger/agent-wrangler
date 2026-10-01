import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import extension, { launchContext, graph, activate, deactivate } from './index.js';
import { MemoryStore, MEMORY_DIR, linkPathFor, addDirFor } from './memory-store.js';
import { createEventBus } from '../../../events.js';
import { loadExtensions, createTaskDeleteNotifier } from '../../index.js';

// A façade double carrying what the manifest `requires` (rebuild, broadcast,
// events) and its own store. The store is the real MemoryStore on a throwaway
// dir, so the symlink and file behaviour under test is the shipped one.
function hostFor(store, extras = {}) {
  const calls = { rebuild: 0, broadcast: [] };
  return {
    calls,
    stores: { taskMemory: store },
    rebuild: async () => { calls.rebuild += 1; },
    broadcast: (p) => calls.broadcast.push(p),
    events: createEventBus(),
    ...extras,
  };
}
const tmpStore = () => new MemoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tm-ext-')));

test('manifest: first builtin shape — enabled by default, owns its handlers, skill, store, hooks and client', () => {
  assert.equal(extension.id, 'task-memory');
  assert.equal(extension.defaultEnabled, true);
  assert.deepEqual(extension.handlers.map((h) => h.type), ['get-memory', 'set-memory']);
  assert.deepEqual(extension.skills, ['task-memory']);
  assert.deepEqual(extension.requires, ['board:rebuild', 'board:broadcast', 'events']);
  assert.equal(typeof extension.hooks['session.launchContext'], 'function');
  assert.equal(typeof extension.onTaskDelete, 'function');
  assert.equal(typeof extension.session.onPurge, 'function');
  assert.ok(extension.stores.taskMemory() instanceof MemoryStore);
  assert.ok(fs.existsSync(path.join(extension.dir, 'skills', 'task-memory', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(extension.dir, extension.client)));
  assert.ok(fs.existsSync(path.join(extension.dir, extension.styles)));
});

test('launchContext (claude): binds the session, hands back the STABLE symlink path and dir', () => {
  const store = new MemoryStore(MEMORY_DIR);
  const out = launchContext({ sid: 'tm-claude', task: { id: 'T1' }, agent: 'claude', host: hostFor(store) });
  assert.deepEqual(out, { env: { AW_TASK_MEMORY: linkPathFor('tm-claude') }, addDirs: [addDirFor('tm-claude')] });
  // …and the binding really exists and points at the task's folder.
  assert.equal(fs.realpathSync(addDirFor('tm-claude')), fs.realpathSync(store.taskDir('T1')));
});

test('launchContext (codex): the RESOLVED real path, never the symlink', () => {
  const store = new MemoryStore(MEMORY_DIR);
  const out = launchContext({ sid: 'tm-codex', task: { id: 'T2' }, agent: 'codex', host: hostFor(store) });
  const real = fs.realpathSync(store.taskDir('T2'));
  assert.deepEqual(out, { env: { AW_TASK_MEMORY: path.join(real, 'memory.md') }, addDirs: [real] });
  assert.ok(!JSON.stringify(out).includes('by-session'));
});

test('launchContext: no task binds the session to its scratch folder; a reassignment repoints the link', () => {
  const store = new MemoryStore(MEMORY_DIR);
  const host = hostFor(store);
  launchContext({ sid: 'tm-scratch', task: null, agent: 'claude', host });
  assert.equal(fs.realpathSync(addDirFor('tm-scratch')), fs.realpathSync(store.scratchDir('tm-scratch')));
  launchContext({ sid: 'tm-scratch', task: { id: 'T3' }, agent: 'claude', host, reason: 'assign' });
  assert.equal(fs.realpathSync(addDirFor('tm-scratch')), fs.realpathSync(store.taskDir('T3')));
});

test('launchContext: an unsafe session id contributes nothing and escapes nothing', () => {
  const store = new MemoryStore(MEMORY_DIR);
  assert.deepEqual(launchContext({ sid: '../evil', task: null, agent: 'claude', host: hostFor(store) }), {});
});

test('graph: stamps hasMemory on each task, and tolerates the boot-time empty graph', () => {
  const store = tmpStore();
  store.write('T1', '# notes');
  store.write('T2', '   ');
  const g = { tasks: { tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] } };
  assert.deepEqual(graph({ host: hostFor(store), graph: g }), {});
  assert.deepEqual(g.tasks.tasks.map((t) => t.hasMemory), [true, false, false]);
  assert.deepEqual(graph({ host: hostFor(store), graph: {} }), {}); // assertGraphKeys passes `graph: {}`
});

test('onTaskDelete (via the loader and notifier): removes the task\'s memory file and session links when enabled', async () => {
  const store = tmpStore();
  store.bindSession('s1', 'T1');
  store.bindSession('s2', 'T2');
  store.write('T1', 'gone soon');
  store.write('T2', 'stays');
  const loaded = loadExtensions({ cfg: {}, builtin: [extension] });
  await createTaskDeleteNotifier(loaded, () => hostFor(store))('T1');
  assert.equal(fs.existsSync(store.taskDir('T1')), false);
  assert.equal(store.read('T1'), '');
  assert.equal(fs.lstatSync(store.linkPath('s1'), { throwIfNoEntry: false }), undefined, 'no dangling link left');
  assert.equal(store.read('T2'), 'stays', 'another task is untouched');
  assert.equal(fs.readlinkSync(store.linkPath('s2')), path.join('..', 'tasks', 'T2'));
});

test('onTaskDelete (via the notifier): nothing is removed when the extension is disabled', async () => {
  const store = tmpStore();
  store.write('T1', 'keep');
  const loaded = loadExtensions({ cfg: { extensions: { 'task-memory': false } }, builtin: [extension] });
  await createTaskDeleteNotifier(loaded, () => hostFor(store))('T1');
  assert.equal(store.read('T1'), 'keep');
});

test('onTaskDelete: a throwing hook does not block the delete (error logged)', async () => {
  const store = tmpStore();
  const errs = [];
  const loaded = loadExtensions({ cfg: {}, builtin: [extension] });
  await createTaskDeleteNotifier(loaded, () => ({ stores: { taskMemory: { deleteTask() { throw new Error('boom'); } } } }), (...a) => errs.push(a))('T1');
  assert.match(errs[0][0], /\[ext:task-memory\] onTaskDelete failed/);
});

test('onTaskDelete: an unsafe task id deletes nothing', () => {
  const store = tmpStore();
  store.write('T1', 'keep');
  extension.onTaskDelete({ taskId: '../tasks/T1', host: hostFor(store) });
  assert.equal(store.read('T1'), 'keep');
});

test('onPurge: forgets the session\'s link and scratch folder, leaving the task folder', () => {
  const store = tmpStore();
  store.bindSession('s9', 'T1');
  store.bindSession('s8', null);
  extension.session.onPurge({ sessionId: 's8', host: hostFor(store) });
  assert.equal(fs.lstatSync(store.linkPath('s8'), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.existsSync(store.scratchDir('s8')), false);
  assert.ok(fs.existsSync(store.taskDir('T1')));
});

test('activate: archive-review:completed appends to the task memory', () => {
  const store = tmpStore();
  const host = hostFor(store);
  activate({ host });
  try {
    host.events.emit('archive-review:completed', { sid: 's', taskId: 'T1', markdown: '\n## Session review\n\n- fact\n' });
    host.events.emit('archive-review:completed', { sid: 's', taskId: 'T1', markdown: '- more\n' });
    assert.equal(store.read('T1'), '\n## Session review\n\n- fact\n- more\n');
    host.events.emit('archive-review:completed', { sid: 's', taskId: null, markdown: 'x' }); // no task: ignored
    host.events.emit('archive-review:completed', { sid: 's', taskId: 'T1', markdown: 42 }); // not text: ignored
    assert.equal(store.read('T1'), '\n## Session review\n\n- fact\n- more\n');
  } finally {
    deactivate({ host });
  }
});

test('activate: the watcher turns a memory change on disk into a rebuild and a `changed` broadcast; deactivate stops it', async () => {
  const store = tmpStore();
  const host = hostFor(store);
  activate({ host });
  try {
    await new Promise((r) => setTimeout(r, 150)); // let chokidar finish its initial scan
    store.write('T1', 'hello');
    for (let i = 0; i < 60 && !host.calls.broadcast.length; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(host.calls.broadcast[0], { kind: 'changed', taskId: 'T1' });
    assert.ok(host.calls.rebuild >= 1);
  } finally {
    deactivate({ host });
  }
  const before = host.calls.broadcast.length;
  store.write('T1', 'after deactivate');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(host.calls.broadcast.length, before, 'a stopped watcher broadcasts nothing');
});

test('deactivate is safe without a store (activation failed before it was built)', () => {
  assert.doesNotThrow(() => deactivate({ host: { stores: {} } }));
  assert.doesNotThrow(() => deactivate({ host: undefined }));
});
