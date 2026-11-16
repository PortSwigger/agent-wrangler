import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNotificationBlocks, BLOCKED_AFTER_MS } from './notification-blocks.js';
import { MailboxStore } from './mailbox-store.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-blocks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mailStore = new MailboxStore(path.join(dir, 'mail.json'));
  const entries = { child: { spawnedBy: 'parent', parentSession: 'nested' }, parent: {}, nested: {} };
  const events = [];
  const blocks = createNotificationBlocks({ entryFor: (id) => entries[id], mailStore,
    events: { emit: (...args) => events.push(args) } });
  return { blocks, entries, events, mailStore };
}

test('five minutes behind a draft flags the board, mails each supervisor once and emits a safe host event', (t) => {
  const { blocks, events, mailStore } = fixture(t);
  blocks.deferred('child', 'composer not confirmed empty: diagnostic', 0);
  assert.equal(blocks.blocked('child', BLOCKED_AFTER_MS - 1), false);
  blocks.sweep(BLOCKED_AFTER_MS - 1);
  assert.equal(mailStore.unreadMessages('parent').length, 0);
  blocks.sweep(BLOCKED_AFTER_MS);
  assert.equal(blocks.blocked('child', BLOCKED_AFTER_MS), true);
  for (const id of ['parent', 'nested']) {
    const mail = mailStore.unreadMessages(id);
    assert.equal(mail.length, 1);
    assert.match(mail[0].body, /#session=child/);
    assert.match(mail[0].body, /unsent text/);
    assert.doesNotMatch(mail[0].body, /diagnostic/);
  }
  assert.deepEqual(events, [['session-notification:blocked', { sid: 'child', reason: 'composer-not-empty', since: 0, at: BLOCKED_AFTER_MS }]]);
  blocks.sweep(BLOCKED_AFTER_MS + 1000);
  assert.equal(events.length, 1);
  assert.equal(mailStore.unreadMessages('parent').length, 1);
  blocks.resolved('child');
  assert.equal(blocks.blocked('child', BLOCKED_AFTER_MS + 1000), false);
  blocks.deferred('child', 'composer not confirmed empty', BLOCKED_AFTER_MS + 2000);
  blocks.sweep(2 * BLOCKED_AFTER_MS + 2000);
  assert.equal(events.length, 2);
});

test('busy, missing and archived sessions do not escalate; supervisor duplicates and self links are ignored', (t) => {
  const { blocks, entries, mailStore, events } = fixture(t);
  blocks.deferred('child', 'board status working', 0);
  blocks.sweep(BLOCKED_AFTER_MS);
  assert.equal(events.length, 0);
  entries.child.parentSession = 'parent';
  blocks.deferred('child', 'composer not confirmed empty', 0);
  blocks.sweep(BLOCKED_AFTER_MS);
  assert.equal(mailStore.unreadMessages('parent').length, 1);
  blocks.resolved('child');
  entries.child.archivedAt = 1;
  blocks.deferred('child', 'composer not confirmed empty', 0);
  blocks.sweep(BLOCKED_AFTER_MS);
  assert.equal(blocks.blocked('child', BLOCKED_AFTER_MS), false);
  assert.equal(events.length, 1);
});

test('canceled work clears a flag and a changed blocker resets its timer', (t) => {
  const { entries, mailStore, events } = fixture(t);
  let pending = true;
  const blocks = createNotificationBlocks({ entryFor: (id) => entries[id], mailStore,
    events: { emit: (...args) => events.push(args) }, isPending: () => pending });
  blocks.deferred('child', 'composer not confirmed empty', 0);
  blocks.deferred('child', 'board status working', BLOCKED_AFTER_MS - 1);
  blocks.sweep(BLOCKED_AFTER_MS);
  assert.equal(events.length, 0);
  blocks.deferred('child', 'composer not confirmed empty', BLOCKED_AFTER_MS);
  pending = false;
  blocks.sweep(2 * BLOCKED_AFTER_MS);
  assert.equal(blocks.blocked('child', 2 * BLOCKED_AFTER_MS), false);
  assert.equal(events.length, 0);
});

test('a full supervisor mailbox retries without repeating the host event or other supervisor mail', (t) => {
  const { blocks, mailStore, events } = fixture(t);
  for (let i = 0; i < 20; i++) mailStore.append('parent', { from: 'other', body: 'message' }, 0);
  blocks.deferred('child', 'composer not confirmed empty', 0);
  blocks.sweep(BLOCKED_AFTER_MS);
  assert.equal(mailStore.unreadMessages('nested').length, 1);
  mailStore.drain('parent', BLOCKED_AFTER_MS);
  blocks.sweep(BLOCKED_AFTER_MS + 1000);
  assert.equal(mailStore.unreadMessages('parent').length, 1);
  assert.equal(mailStore.unreadMessages('nested').length, 1);
  assert.equal(events.length, 1);
});
