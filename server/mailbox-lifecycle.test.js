import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailboxStore, UNREAD_TTL_MS } from './mailbox-store.js';
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
  // Mirrors the composed binding in server/index.js: prune read/undeliverable,
  // then expire unread mail older than the conversation itself would be.
  sm._pruneMailOnArchive = (sessionId, now = Date.now()) => {
    mailStore.pruneOnArchive(sessionId);
    mailStore.expireStaleUnread(sessionId, now - UNREAD_TTL_MS);
  };
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

  const now = Date.now();
  const { id: readId } = mailStore.append('CARD1', { from: 'peer', body: 'already read' }, now - 3000);
  mailStore.getOne('CARD1', readId);
  mailStore.append('CARD1', { from: 'peer', body: 'never delivered' }, now - 2000);
  mailStore.markUndeliverable('CARD1');
  mailStore.append('CARD1', { from: 'peer', body: 'still waiting' }, now - 1000);

  sm.archive('CARD1');

  // Archive is "set aside", not end-of-life (resume clears archivedAt), and the
  // sender of the unread message was told queued:true — so unread mail must
  // still be there for the card to read when it comes back. Read from a fresh
  // store: the prune has to have been persisted, not just applied in memory.
  const reloaded = new MailboxStore(file);
  assert.deepEqual(reloaded.list('CARD1').map((m) => m.body), ['still waiting']);
  assert.equal(reloaded.unreadInfo('CARD1', now).unread, 1);
});

test('archive: a box holding nothing but read mail goes away entirely', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);
  const { id } = mailStore.append('CARD1', { from: 'peer', body: 'x' }, Date.now() - 1000);
  mailStore.takeDueSettles(Date.now() + 60_000); // the settle window closed, as mail-runner.js does
  mailStore.getOne('CARD1', id);
  sm.archive('CARD1');
  assert.equal(mailStore.boxes.has('CARD1'), false);
});

test('archive → resume → archive: each live span\'s own read mail is pruned, and unread mail rides through', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);

  const now = Date.now();
  const { id: first } = mailStore.append('CARD1', { from: 'peer', body: 'span one' }, now - 3000);
  mailStore.getOne('CARD1', first);
  sm.archive('CARD1');
  assert.deepEqual(mailStore.list('CARD1'), []);

  // Resume clears archivedAt — the card is live again and takes new mail.
  delete sm.entryFor('CARD1').archivedAt;
  const { id: second } = mailStore.append('CARD1', { from: 'peer', body: 'span two' }, now - 2000);
  mailStore.getOne('CARD1', second);
  mailStore.append('CARD1', { from: 'peer', body: 'unread at archive time' }, now - 1000);

  sm.archive('CARD1');
  assert.deepEqual(mailStore.list('CARD1').map((m) => m.body), ['unread at archive time']);
});

test('archive: re-archiving an already-archived session is a no-op for the mailbox', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);
  mailStore.append('CARD1', { from: 'peer', body: 'unread' }, Date.now() - 1000);
  sm.archive('CARD1');
  const after = mailStore.list('CARD1');
  sm.archive('CARD1'); // the prune deliberately is NOT gated on wasArchived
  assert.deepEqual(mailStore.list('CARD1'), after);
});

// The order that actually happens in production, and the reverse of what the
// store-level test constructs: mail arrives at a LIVE card, the card is archived
// mid-settle-window (so the prune sees it still 'unread' and keeps it), and only
// then does the settle sweep discover the card is archived and mark it
// undeliverable. It is the NEXT archive that drops it.
test('archive: mail marked undeliverable AFTER an archive survives that archive and is dropped by the next one', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);
  mailStore.append('CARD1', { from: 'peer', body: 'arrived mid-window' }, Date.now() - 1000);

  sm.archive('CARD1');
  // Still unread at this point, so the prune must not have taken it.
  assert.deepEqual(mailStore.list('CARD1').map((m) => m.state), ['unread']);

  // The settle sweep fires, finds the recipient archived (mail-runner.js).
  mailStore.takeDueSettles(Date.now() + 60_000);
  mailStore.markUndeliverable('CARD1');

  delete sm.entryFor('CARD1').archivedAt; // resumed
  sm.archive('CARD1'); // archived again
  // Dropped — approved scope, and not a broken promise: `drain()` already
  // excludes undeliverable mail permanently, so it was never going to be
  // delivered, and it was always evictable under the retention caps.
  assert.deepEqual(mailStore.list('CARD1'), []);
});

test('archive: unread mail older than the conversation itself would be is expired', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);
  // Older than UNREAD_TTL_MS: past this point Claude Code has deleted the
  // transcript and resolveResumeDir refuses to resume the card at all, so this
  // mail can never be read by the agent it was addressed to.
  mailStore.append('CARD1', { from: 'peer', body: 'stale' }, Date.now() - UNREAD_TTL_MS - 1000);
  mailStore.append('CARD1', { from: 'peer', body: 'still current' }, Date.now());
  sm.archive('CARD1');
  assert.deepEqual(mailStore.list('CARD1').map((m) => m.body), ['still current']);
});

test('a LIVE card\'s unread mail is never expired, however old — the TTL is archived-only', () => {
  const mailStore = new MailboxStore(tmpFile());
  const sm = managerWith(mailStore);
  mailStore.append('CARD1', { from: 'peer', body: 'ancient but still deliverable' }, Date.now() - UNREAD_TTL_MS * 10);
  // Nothing on a live card's path calls expireStaleUnread: it can be read at any
  // moment, so age alone must never discard it. Pinned by exercising every other
  // mutator the live path uses.
  mailStore.takeDueSettles(Date.now());
  mailStore.markNotified('CARD1', Date.now());
  mailStore.append('CARD1', { from: 'peer', body: 'newer' }, Date.now());
  assert.equal(mailStore.list('CARD1').length, 2);
  assert.equal(sm.isArchived('CARD1'), false);
});
