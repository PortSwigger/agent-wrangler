import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MailboxStore, SETTLE_MS, AMBER_MS, UNREAD_CAP_MESSAGES, UNREAD_CAP_BYTES,
  READ_RETENTION_MESSAGES,
} from './mailbox-store.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mailbox-')), 'mailbox.json');
}

test('append: opens a settle window on first arrival', () => {
  const store = new MailboxStore(tmpFile());
  const now = 1000;
  store.append('rcpt', { from: 'a', body: 'hi' }, now);
  assert.deepEqual(store.takeDueSettles(now + SETTLE_MS - 1), []);
  assert.deepEqual(store.takeDueSettles(now + SETTLE_MS), ['rcpt']);
});

test('append: fan-in from multiple senders batches into ONE settle window (recipient-only key)', () => {
  const store = new MailboxStore(tmpFile());
  const now = 1000;
  store.append('rcpt', { from: 'a', body: 'one' }, now);
  // A second sender arriving mid-window joins the SAME window rather than
  // opening its own — this is what makes fan-in batch.
  store.append('rcpt', { from: 'b', body: 'two' }, now + 2000);
  assert.deepEqual(store.takeDueSettles(now + SETTLE_MS - 1), []);
  assert.deepEqual(store.takeDueSettles(now + SETTLE_MS), ['rcpt']);
  const drained = store.drain('rcpt');
  assert.equal(drained.length, 2);
});

test('append: fixed window — a later message does NOT extend the deadline (not a debounce)', () => {
  const store = new MailboxStore(tmpFile());
  const now = 1000;
  store.append('rcpt', { from: 'a', body: 'one' }, now);
  store.append('rcpt', { from: 'b', body: 'two' }, now + SETTLE_MS - 1); // arrives just before close
  // The window still closes at now+SETTLE_MS, not (now+SETTLE_MS-1)+SETTLE_MS.
  assert.deepEqual(store.takeDueSettles(now + SETTLE_MS), ['rcpt']);
});

test('takeDueSettles: a steady trickle cannot starve the recipient — each window closes independently', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'one' }, 0);
  assert.deepEqual(store.takeDueSettles(SETTLE_MS), ['rcpt']);
  store.markNotified('rcpt', SETTLE_MS);
  // A trickle after the first window closed opens a FRESH window.
  store.append('rcpt', { from: 'a', body: 'two' }, SETTLE_MS + 5);
  assert.deepEqual(store.takeDueSettles(SETTLE_MS + 5 + SETTLE_MS), ['rcpt']);
});

test('takeDueSettles: clears the deadline synchronously at selection (idempotent even without markNotified)', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'one' }, 0);
  assert.deepEqual(store.takeDueSettles(SETTLE_MS), ['rcpt']);
  assert.deepEqual(store.takeDueSettles(SETTLE_MS + 1), []); // not selected twice
});

test('drain: oldest-first, marks read, excludes undeliverable', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'first' }, 100);
  store.append('rcpt', { from: 'b', body: 'second' }, 200);
  const drained = store.drain('rcpt', 300);
  assert.equal(drained.length, 2);
  assert.equal(drained[0].body, 'first');
  assert.equal(drained[1].body, 'second');
  assert.equal(drained[0].state, 'read');
  assert.equal(drained[0].readAt, 300);
  assert.deepEqual(store.drain('rcpt'), []); // nothing left unread
});

test('getOne: fetches by id regardless of state, marks unread as read', () => {
  const store = new MailboxStore(tmpFile());
  const { id } = store.append('rcpt', { from: 'a', body: 'body text' }, 100);
  const msg = store.getOne('rcpt', id, 200);
  assert.equal(msg.body, 'body text');
  assert.equal(msg.state, 'read');
  assert.equal(msg.readAt, 200);
  assert.equal(store.getOne('rcpt', 'nope'), null);
});

test('list: metadata only (no body assumption enforced by caller), oldest-first, includes every state', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 100);
  store.append('rcpt', { from: 'b', body: 'y' }, 50);
  const list = store.list('rcpt');
  assert.equal(list.length, 2);
  assert.equal(list[0].from, 'b'); // 50 < 100
  assert.equal(list[1].from, 'a');
});

test('markUndeliverable: unread → undeliverable; never re-surfaces via drain; retrievable by id', () => {
  const store = new MailboxStore(tmpFile());
  const { id } = store.append('rcpt', { from: 'a', body: 'x' }, 100);
  store.markUndeliverable('rcpt');
  assert.deepEqual(store.drain('rcpt'), []); // never drained as if it just arrived
  const msg = store.getOne('rcpt', id);
  assert.equal(msg.state, 'undeliverable');
});

test('markUndeliverable: does not touch already-read mail', () => {
  const store = new MailboxStore(tmpFile());
  const { id } = store.append('rcpt', { from: 'a', body: 'x' }, 100);
  store.getOne('rcpt', id); // read it
  store.markUndeliverable('rcpt');
  assert.equal(store.getOne('rcpt', id).state, 'read');
});

test('box cap: refuses at the message-count cap', () => {
  const store = new MailboxStore(tmpFile());
  for (let i = 0; i < UNREAD_CAP_MESSAGES; i++) store.append('rcpt', { from: 'a', body: 'x' }, i);
  assert.throws(() => store.append('rcpt', { from: 'a', body: 'x' }, 999), /backed up/);
});

test('box cap: refuses at the byte cap even under the message-count cap', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x'.repeat(UNREAD_CAP_BYTES - 10) }, 1);
  assert.throws(() => store.append('rcpt', { from: 'a', body: 'x'.repeat(20) }, 2), /backed up/);
});

test('box cap: a refused send writes nothing (no partial append)', () => {
  const store = new MailboxStore(tmpFile());
  for (let i = 0; i < UNREAD_CAP_MESSAGES; i++) store.append('rcpt', { from: 'a', body: 'x' }, i);
  try { store.append('rcpt', { from: 'a', body: 'x' }, 999); } catch { /* expected */ }
  assert.equal(store.list('rcpt').length, UNREAD_CAP_MESSAGES);
});

test('retention: read mail evicted oldest-first past the per-box cap; unread is never evicted', () => {
  const store = new MailboxStore(tmpFile());
  for (let i = 0; i < READ_RETENTION_MESSAGES; i++) {
    const { id } = store.append('rcpt', { from: 'a', body: `msg${i}` }, i);
    store.getOne('rcpt', id); // read immediately
  }
  const { id: unreadId } = store.append('rcpt', { from: 'a', body: 'newest unread' }, 9999);
  // One more read message pushes the box over the retention cap.
  const { id: extraId } = store.append('rcpt', { from: 'a', body: 'extra' }, 10000);
  store.getOne('rcpt', extraId);
  const list = store.list('rcpt');
  assert.ok(list.length <= READ_RETENTION_MESSAGES + 1); // +1 for the still-unread message
  assert.ok(list.some((m) => m.id === unreadId)); // unread survives eviction
  assert.ok(!list.some((m) => m.body === 'msg0')); // the oldest read message was evicted first
});

test('unreadInfo: no unread mail → no pill', () => {
  const store = new MailboxStore(tmpFile());
  assert.deepEqual(store.unreadInfo('rcpt', 1000), { unread: 0, notifiedAt: null, amber: false, senders: [] });
});

test('unreadInfo: normal (< 30min since notify) vs amber (>= 30min)', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 0);
  store.markNotified('rcpt', 0);
  assert.equal(store.unreadInfo('rcpt', AMBER_MS - 1).amber, false);
  assert.equal(store.unreadInfo('rcpt', AMBER_MS).amber, true);
});

test('unreadInfo: never-notified mail (resume failed) still ages off the oldest unread message', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 0); // no markNotified call
  const info = store.unreadInfo('rcpt', AMBER_MS);
  assert.equal(info.notifiedAt, null);
  assert.equal(info.amber, true); // ages off the message's own `at`, not stuck forever
});

test('unreadInfo: senders are deduped, in message order, unread only', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'sess_a', body: 'x' }, 0);
  store.append('rcpt', { from: 'sess_b', body: 'y' }, 1);
  store.append('rcpt', { from: 'sess_a', body: 'z' }, 2);
  assert.deepEqual(store.unreadInfo('rcpt', 1000).senders, ['sess_a', 'sess_b']);
});

test('undeliverable mail does not count toward unreadInfo', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 0);
  store.markUndeliverable('rcpt');
  assert.deepEqual(store.unreadInfo('rcpt', 1000), { unread: 0, notifiedAt: null, amber: false, senders: [] });
});

test('restart persistence: reload from disk keeps messages, settle deadline, and lastNotifiedAt', () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  store.append('rcpt', { from: 'a', fromLabel: 'Alice', body: 'hello' }, 0);
  store.markNotified('rcpt', 5);

  const reloaded = new MailboxStore(file);
  assert.equal(reloaded.list('rcpt').length, 1);
  assert.equal(reloaded.list('rcpt')[0].fromLabel, 'Alice');
  assert.equal(reloaded.boxes.get('rcpt').lastNotifiedAt, 5);
});

test('restart persistence: a settle window whose deadline passed while the process was down fires on the first sweep after boot', () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  store.append('rcpt', { from: 'a', body: 'hello' }, 0); // deadline = SETTLE_MS

  const reloaded = new MailboxStore(file); // simulates a restart
  // "Down" for way longer than the settle window — the deadline is long past.
  assert.deepEqual(reloaded.takeDueSettles(SETTLE_MS + 60 * 60 * 1000), ['rcpt']);
});

test('forget: drops the whole box (card purge)', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 0);
  store.forget('rcpt');
  assert.deepEqual(store.list('rcpt'), []);
});
