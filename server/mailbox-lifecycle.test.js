import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailboxStore } from './mailbox-store.js';
import { SessionManager } from './session-manager.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mail-life-')), 'mailbox.json');
}

// A SessionManager wired the way server/index.js wires it: the _pruneMailOnArchive
// seam bound to the real store. Everything that would touch a real machine
// (tmux, mappings.json) is stubbed.
function managerWith(mailStore, cardId = 'CARD1') {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => {};
  sm._pruneMailOnArchive = (sessionId) => mailStore.pruneOnArchive(sessionId);
  sm.map.set(cardId, { tmux: 'cc_a', cwd: os.tmpdir(), agent: 'claude' });
  return sm;
}

test('archive: the seam is called with the card id (this is the only wiring server/index.js supplies)', () => {
  const sm = new SessionManager();
  sm._save = () => {};
  const seen = [];
  sm._pruneMailOnArchive = (id) => seen.push(id);
  sm.map.set('CARD1', { tmux: 'cc_a', cwd: os.tmpdir() });
  sm.archive('CARD1');
  assert.deepEqual(seen, ['CARD1']);
});

test('archive: read and undeliverable mail is dropped, the box and its UNREAD mail survive', () => {
  const file = tmpFile();
  const mailStore = new MailboxStore(file);
  const sm = managerWith(mailStore);

  const { id: readId } = mailStore.append('CARD1', { from: 'peer', body: 'already read' }, 1);
  mailStore.getOne('CARD1', readId);
  mailStore.append('CARD1', { from: 'peer', body: 'never delivered' }, 2);
  mailStore.markUndeliverable('CARD1');
  mailStore.append('CARD1', { from: 'peer', body: 'still waiting' }, 3);

  sm.archive('CARD1');

  // Archive is "set aside", not end-of-life (resume clears archivedAt), and the
  // sender of the unread message was told queued:true — so unread mail must
  // still be there for the card to read when it comes back. Read from a fresh
  // store: the prune has to have been persisted, not just applied in memory.
  const reloaded = new MailboxStore(file);
  assert.deepEqual(reloaded.list('CARD1').map((m) => m.body), ['still waiting']);
  assert.equal(reloaded.unreadInfo('CARD1', 4).unread, 1);
});

test('archive: a box holding nothing but read mail goes away entirely', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);
  const { id } = mailStore.append('CARD1', { from: 'peer', body: 'x' }, 1);
  mailStore.takeDueSettles(60_000); // the settle window closed, as mail-runner.js does
  mailStore.getOne('CARD1', id);
  sm.archive('CARD1');
  assert.equal(mailStore.boxes.has('CARD1'), false);
});

test('archive → resume → archive: each live span\'s own read mail is pruned, and unread mail rides through', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);

  const { id: first } = mailStore.append('CARD1', { from: 'peer', body: 'span one' }, 1);
  mailStore.getOne('CARD1', first);
  sm.archive('CARD1');
  assert.deepEqual(mailStore.list('CARD1'), []);

  // Resume clears archivedAt — the card is live again and takes new mail.
  delete sm.entryFor('CARD1').archivedAt;
  const { id: second } = mailStore.append('CARD1', { from: 'peer', body: 'span two' }, 100);
  mailStore.getOne('CARD1', second);
  mailStore.append('CARD1', { from: 'peer', body: 'unread at archive time' }, 101);

  sm.archive('CARD1');
  assert.deepEqual(mailStore.list('CARD1').map((m) => m.body), ['unread at archive time']);
});

test('archive: re-archiving an already-archived session is a no-op for the mailbox', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);
  mailStore.append('CARD1', { from: 'peer', body: 'unread' }, 1);
  sm.archive('CARD1');
  const after = mailStore.list('CARD1');
  sm.archive('CARD1'); // the prune deliberately is NOT gated on wasArchived
  assert.deepEqual(mailStore.list('CARD1'), after);
});
