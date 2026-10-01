import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChecklistStore } from './store.js';
import manifest from './index.js';
import { loadExtensions } from '../../index.js';
import { SessionManager } from '../../../session-manager.js';

function file() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ck-life-')), 'checklists.json');
}

function store() {
  return new ChecklistStore(file());
}

// Binds the manifest's session hooks onto a SessionManager exactly the way
// server/index.js activateExtension does: each hook is handed the payload plus
// the extension's own `host`, here a façade carrying just the store.
function bindHooks(sm, checklistStore) {
  const loaded = loadExtensions({ cfg: {}, builtin: [manifest] });
  const host = { stores: { checklist: checklistStore } };
  for (const [name, hooks] of Object.entries(loaded.sessionHooks)) {
    for (const { fn } of hooks) sm._extHooks[name].push((payload) => fn({ ...payload, host }));
  }
}

// The checklist has no copy-on-fork logic BY DESIGN — a fork is a new
// exploratory branch, and carrying over a half-done list from the parent adds
// complexity nobody asked for (same call the mailbox made for unread mail). The
// mechanism is simply that fork() mints a FRESH card id, so this pins the thing
// that would break if someone ever added a copy: the fork's own list is empty
// and the parent's is untouched.
test('fork: the fork gets a new card id and starts with an EMPTY checklist', async () => {
  const checklistStore = store();
  const sm = new SessionManager();
  sm._newSession = async () => {};
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  bindHooks(sm, checklistStore);

  checklistStore.add('PARENT', 'parent work', 1);
  const { sessionId: forkId } = await sm.fork({
    sourceId: 'SRC',
    parentId: 'PARENT',
    parentEntry: { agent: 'claude', cwd: os.tmpdir() },
    cwd: os.tmpdir(),
  });

  assert.notEqual(forkId, 'PARENT');
  assert.deepEqual(checklistStore.list(forkId), [], 'a fork must start with nothing');
  assert.deepEqual(checklistStore.list('PARENT').map((i) => i.text), ['parent work'], "the parent's list is untouched");
  // And the store has no entry at all for the fork, not an empty array — the map
  // stays sparse until something is actually added.
  assert.ok(!(forkId in checklistStore.snapshot()));
});

test('archive then resume: the checklist is retained and comes back', async () => {
  const f = file();
  const checklistStore = new ChecklistStore(f);
  const sm = new SessionManager();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => {};
  bindHooks(sm, checklistStore);
  sm.map.set('CARD1', { tmux: 'cc_a', cwd: os.tmpdir(), agent: 'claude' });

  const item = checklistStore.add('CARD1', 'still mine', 5);
  await sm.archive('CARD1');
  assert.ok(sm.entryFor('CARD1').archivedAt, 'the card is archived, not gone');
  // Archive is "set aside", not end-of-life: nothing on the archive path may
  // touch the store, and a fresh read (a server restart, or the resumed card
  // reading its own list) still finds it.
  assert.deepEqual(new ChecklistStore(f).list('CARD1'), [{ ...item }]);
});

// The purge (SessionManager.forget, reached from the `remove` handler) is the
// ONLY thing that drops a checklist, and it reaches the store through the
// extension's `onPurge` session hook — core no longer knows the store exists.
test('purge (forget) fires the extension\'s onPurge hook, the only thing that drops a checklist', async () => {
  const checklistStore = store();
  checklistStore.add('CARD1', 'doomed');
  checklistStore.add('CARD2', 'unrelated');
  const sm = new SessionManager();
  sm._save = () => {};
  bindHooks(sm, checklistStore);
  sm.map.set('CARD1', { tmux: 'cc_a', cwd: os.tmpdir(), agent: 'claude' });
  sm.map.set('CARD2', { tmux: 'cc_b', cwd: os.tmpdir(), agent: 'claude' });

  sm.forget('CARD1');
  await new Promise((r) => setImmediate(r)); // forget() fires hooks without awaiting
  assert.deepEqual(checklistStore.list('CARD1'), []);
  assert.deepEqual(checklistStore.list('CARD2').map((i) => i.text), ['unrelated'], 'only the purged card');
});

test('the onPurge hook tolerates a card that never had a checklist', () => {
  const checklistStore = store();
  const hook = loadExtensions({ cfg: {}, builtin: [manifest] }).sessionHooks.onPurge[0].fn;
  assert.doesNotThrow(() => hook({ sessionId: 'NEVER', host: { stores: { checklist: checklistStore } } }));
});
