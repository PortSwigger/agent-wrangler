import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChecklistStore } from './checklist-store.js';
import { SessionManager } from './session-manager.js';
import { removeHandler } from './control/handlers/remove.js';

function store() {
  return new ChecklistStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ck-life-')), 'checklists.json'));
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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ck-life-')), 'checklists.json');
  const checklistStore = new ChecklistStore(file);
  const sm = new SessionManager();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => {};
  sm.map.set('CARD1', { tmux: 'cc_a', cwd: os.tmpdir(), agent: 'claude' });

  const item = checklistStore.add('CARD1', 'still mine', 5);
  await sm.archive('CARD1');
  assert.ok(sm.entryFor('CARD1').archivedAt, 'the card is archived, not gone');
  // Archive is "set aside", not end-of-life: nothing on the archive path may
  // touch the store, and a fresh read (a server restart, or the resumed card
  // reading its own list) still finds it.
  assert.deepEqual(new ChecklistStore(file).list('CARD1'), [{ ...item }]);
});

test('purge (the remove handler) is the ONLY thing that drops a checklist', async () => {
  const checklistStore = store();
  checklistStore.add('CARD1', 'doomed');
  checklistStore.add('CARD2', 'unrelated');
  const ctx = {
    sessionManager: { killForSession: async () => {}, forget: () => {} },
    taskStore: { unassign: () => {} },
    memoryStore: { forget: () => {} },
    mailStore: { forget: () => {} },
    checklistStore,
    rebuild: async () => {},
  };
  await removeHandler.handler({ type: 'remove', sessionId: 'CARD1' }, ctx);
  assert.deepEqual(checklistStore.list('CARD1'), []);
  assert.deepEqual(checklistStore.list('CARD2').map((i) => i.text), ['unrelated'], 'only the purged card');
});
