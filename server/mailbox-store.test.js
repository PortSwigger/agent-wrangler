import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MailboxStore, SETTLE_MS, AMBER_MS, UNREAD_CAP_MESSAGES, UNREAD_CAP_BYTES,
  READ_RETENTION_MESSAGES, READ_RETENTION_BYTES, TOTAL_STORE_CAP_BYTES, UNREAD_TTL_MS, READ_GRACE_MS,
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

test('retention: undeliverable mail is evictable too — it must count toward the same caps as read mail, not sit outside every cap forever', () => {
  const store = new MailboxStore(tmpFile());
  // Append + immediately mark undeliverable, one at a time, so the 20-message
  // UNREAD cap (a separate, narrower cap) is never in play — this test is
  // about the READ_RETENTION cap on evictable (read + undeliverable) mail.
  for (let i = 0; i < READ_RETENTION_MESSAGES; i++) {
    store.append('rcpt', { from: 'a', body: `msg${i}` }, i);
    store.markUndeliverable('rcpt');
  }
  // One more pushes the box over the retention cap.
  store.append('rcpt', { from: 'a', body: 'extra' }, 10000);
  store.markUndeliverable('rcpt');
  const list = store.list('rcpt');
  assert.ok(list.length <= READ_RETENTION_MESSAGES);
  assert.ok(!list.some((m) => m.body === 'msg0')); // the oldest evictable message was evicted first
});

test('whole-store eviction can reclaim undeliverable mail across boxes when no read mail exists anywhere — this is exactly what was unreclaimable before the fix (the eviction loop broke on the first iteration and the whole-store cap was unenforceable)', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt1', { from: 'a', body: 'older' }, 1);
  store.markUndeliverable('rcpt1');
  store.append('rcpt2', { from: 'a', body: 'newer' }, 2);
  store.markUndeliverable('rcpt2');
  assert.equal(store._evictOldestEvictableAnywhere(), true);
  assert.equal(store.list('rcpt1').length, 0); // the OLDER (at:1) undeliverable message was evicted first
  assert.equal(store.list('rcpt2').length, 1);
  assert.equal(store._evictOldestEvictableAnywhere(), true); // rcpt2's is now the oldest remaining
  assert.equal(store._evictOldestEvictableAnywhere(), false); // nothing evictable left
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

test('unreadInfo: brand-new mail is NOT reported stale off a stale lastNotifiedAt from an earlier, already-drained batch', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'first batch' }, 0);
  store.takeDueSettles(SETTLE_MS); // closes the window, as mail-runner.js does before notifying
  store.markNotified('rcpt', SETTLE_MS);
  store.drain('rcpt'); // box now empty; lastNotifiedAt=SETTLE_MS lingers on the box
  // A new message arrives 8 hours later — a FRESH pending settle window opens
  // (settleDeadline was cleared above, so append() opens a new one).
  const EIGHT_HOURS = 8 * 60 * 60 * 1000;
  store.append('rcpt', { from: 'b', body: 'second batch' }, EIGHT_HOURS);
  // Checked moments later, while the settle window is still pending: must NOT
  // report amber off the ~8-hour-old lastNotifiedAt for mail that just arrived.
  const info = store.unreadInfo('rcpt', EIGHT_HOURS + 3000);
  assert.equal(info.amber, false);
});

test('unreadInfo: a re-armed settle window (failed delivery) uses the NEW message\'s own age, not a stale lastNotifiedAt left over from an earlier, already-drained batch', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'old batch' }, 0);
  store.takeDueSettles(SETTLE_MS);
  store.markNotified('rcpt', SETTLE_MS);
  store.drain('rcpt'); // box now empty; lastNotifiedAt = SETTLE_MS lingers on the box
  const EIGHT_HOURS = 8 * 60 * 60 * 1000;
  store.append('rcpt', { from: 'b', body: 'new message' }, EIGHT_HOURS); // opens a fresh window
  store.takeDueSettles(EIGHT_HOURS + SETTLE_MS); // sweep attempts delivery...
  store.reopenSettle('rcpt', EIGHT_HOURS + SETTLE_MS); // ...and it fails, so mail-runner.js re-arms
  // Checked shortly after the failed attempt: the new message is only ~10s old — not stale,
  // even though lastNotifiedAt (SETTLE_MS) is ~8 hours in the past.
  assert.equal(store.unreadInfo('rcpt', EIGHT_HOURS + SETTLE_MS + 3000).amber, false);
});

test('unreadInfo: once the settle window closes (takeDueSettles + markNotified, the real flow) the notifiedAt is trusted again', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 0);
  store.takeDueSettles(SETTLE_MS); // closes the window, as mail-runner.js does before notifying
  store.markNotified('rcpt', SETTLE_MS);
  assert.equal(store.unreadInfo('rcpt', SETTLE_MS + AMBER_MS - 1).amber, false);
  assert.equal(store.unreadInfo('rcpt', SETTLE_MS + AMBER_MS).amber, true); // genuinely stale — no pending window masking it
});

test('reopenSettle: no-op when the box has no unread mail left (e.g. concurrently marked undeliverable) — does not touch whatever deadline is already there', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 0); // opens a deadline at SETTLE_MS
  store.markUndeliverable('rcpt'); // no unread left; does not itself touch settleDeadline
  const before = store.boxes.get('rcpt').settleDeadline;
  store.reopenSettle('rcpt', 5000);
  assert.equal(store.boxes.get('rcpt').settleDeadline, before); // unchanged, not re-armed to 5000+SETTLE_MS
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

test('read retention is pinned to the unread caps — a single drain can hand back UNREAD_CAP_MESSAGES messages, so retention must outlive the whole of one', () => {
  assert.equal(READ_RETENTION_MESSAGES, UNREAD_CAP_MESSAGES);
  assert.equal(READ_RETENTION_BYTES, UNREAD_CAP_BYTES);
});

test('read retention outlives a full drain: every message of a max-size batch is still fetchable by id afterwards', () => {
  const store = new MailboxStore(tmpFile());
  for (let i = 0; i < UNREAD_CAP_MESSAGES; i++) store.append('rcpt', { from: 'a', body: `msg${i}` }, i);
  const drained = store.drain('rcpt', 999);
  assert.equal(drained.length, UNREAD_CAP_MESSAGES);
  // The excerpt follow-up read_mail({id}) this retention exists for — including
  // for the EARLIEST message of the batch, which a smaller cap would have
  // evicted during the very drain that delivered it.
  for (const m of drained) assert.equal(store.getOne('rcpt', m.id).body, m.body);
});

test('empty boxes are pruned: no messages and no open settle window holds nothing', () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  const { id } = store.append('rcpt', { from: 'a', body: 'x' }, 0);
  store.takeDueSettles(SETTLE_MS); // clears the deadline, as mail-runner.js does
  store.getOne('rcpt', id); // read
  store.pruneOnArchive('rcpt'); // drops the read message, emptying the box
  assert.equal(store.boxes.has('rcpt'), false);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length, 0);
  // Lazily recreated on demand — nothing downstream can tell.
  assert.deepEqual(store.list('rcpt'), []);
});

test('empty boxes with an OPEN settle window are kept — the deadline is live state a restart must recover', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 0); // opens a deadline at SETTLE_MS
  store.markUndeliverable('rcpt');
  store.pruneOnArchive('rcpt'); // drops the undeliverable message
  assert.equal(store.boxes.get('rcpt').settleDeadline, SETTLE_MS);
});

test('load sweep: a box written over the CURRENT caps is trimmed at load, not left dormant and oversized forever', () => {
  const file = tmpFile();
  // Retention is otherwise enforced lazily (only on a mutation of that box), so
  // a store written by a version with looser caps would keep an oversized box
  // forever if it never receives mail again. Written straight to disk to model
  // exactly that.
  const messages = [];
  for (let i = 0; i < READ_RETENTION_MESSAGES + 30; i++) {
    messages.push({ id: `mail_old${i}`, from: 'a', fromLabel: null, at: i, body: `msg${i}`, size: 5, state: 'read', readAt: i });
  }
  messages.push({ id: 'mail_unread', from: 'a', fromLabel: null, at: 99999, body: 'still unread', size: 12, state: 'unread', readAt: null });
  fs.writeFileSync(file, JSON.stringify({ rcpt: { messages, settleDeadline: null, lastNotifiedAt: null } }));

  const store = new MailboxStore(file);
  assert.equal(store._evictableCount(store.boxes.get('rcpt')), READ_RETENTION_MESSAGES);
  assert.ok(store.list('rcpt').some((m) => m.id === 'mail_unread')); // unread never swept
  assert.ok(!store.list('rcpt').some((m) => m.body === 'msg0')); // oldest read went first
  // Persisted, not just trimmed in memory.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.rcpt.messages.length, READ_RETENTION_MESSAGES + 1);
});

test('load sweep: an already-compliant store is not rewritten', () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  store.append('rcpt', { from: 'a', body: 'x' }, 0);
  const mtime = fs.statSync(file).mtimeMs;
  const before = fs.readFileSync(file, 'utf8');
  const reloaded = new MailboxStore(file);
  assert.equal(reloaded.list('rcpt').length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime); // no save at all
});

test('load sweep: a message written without `size` gets one re-derived, so byte trimming is not silently NaN-disabled', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    rcpt: { messages: [{ id: 'mail_x', from: 'a', at: 1, body: 'hello', state: 'read', readAt: 1 }], settleDeadline: null, lastNotifiedAt: null },
  }));
  const store = new MailboxStore(file);
  assert.equal(store.list('rcpt')[0].size, 5);
  assert.equal(store._totalBytes(), 5); // not NaN, which `> cap` would silently pass
});

test('load sweep: drops empty boxes left behind by an older version', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    empty: { messages: [], settleDeadline: null, lastNotifiedAt: 5 },
    live: { messages: [{ id: 'mail_a', from: 'a', at: 1, body: 'x', size: 1, state: 'unread', readAt: null }], settleDeadline: null, lastNotifiedAt: null },
  }));
  const store = new MailboxStore(file);
  assert.deepEqual([...store.boxes.keys()], ['live']);
});

test('load sweep: the whole-store cap is enforced at load and never evicts unread mail', () => {
  const file = tmpFile();
  // 17 x 256KB of read mail = ~4.25MB, over the 4MB whole-store cap, with no
  // single box breaching the per-box cap — only _evictOldestEvictableAnywhere
  // can reclaim this, and nothing in practice has ever exercised it. Built on
  // disk rather than through appends: one stringify in, one save out.
  const raw = {};
  const per = READ_RETENTION_BYTES; // exactly one box's full allowance
  const boxCount = Math.ceil(TOTAL_STORE_CAP_BYTES / per) + 1;
  for (let b = 0; b < boxCount; b++) {
    raw[`rcpt${b}`] = {
      messages: [{ id: `mail_${b}`, from: 'a', fromLabel: null, at: b, body: 'x', size: per, state: 'read', readAt: b }],
      settleDeadline: null,
      lastNotifiedAt: null,
    };
  }
  // One box also holds unread mail, which must survive whatever the sweep evicts.
  raw.rcpt0.messages.push({ id: 'mail_unread', from: 'a', fromLabel: null, at: 1, body: 'keep me', size: 7, state: 'unread', readAt: null });

  fs.writeFileSync(file, JSON.stringify(raw));
  assert.ok(boxCount * per > TOTAL_STORE_CAP_BYTES); // the store as written really is over the cap

  const swept = new MailboxStore(file);
  assert.ok(swept._totalBytes() <= TOTAL_STORE_CAP_BYTES, `total ${swept._totalBytes()} over cap`);
  // Read via list() rather than getOne(), which would itself mark it read.
  assert.deepEqual(swept.list('rcpt0').filter((m) => m.state === 'unread').map((m) => m.id), ['mail_unread']);
  // Evicted oldest-first across boxes, so the newest box's read mail is intact.
  assert.equal(swept.list(`rcpt${boxCount - 1}`).length, 1);
});

test('whole-store cap: a store over the cap with nothing evictable terminates and keeps every unread message', () => {
  const file = tmpFile();
  const raw = {};
  const per = READ_RETENTION_BYTES;
  const boxCount = Math.ceil(TOTAL_STORE_CAP_BYTES / per) + 1;
  for (let b = 0; b < boxCount; b++) {
    raw[`rcpt${b}`] = {
      messages: [{ id: `mail_${b}`, from: 'a', fromLabel: null, at: b, body: 'x', size: per, state: 'unread', readAt: null }],
      settleDeadline: null,
      lastNotifiedAt: null,
    };
  }
  fs.writeFileSync(file, JSON.stringify(raw));
  const store = new MailboxStore(file); // must not hang: the eviction loop breaks when nothing is evictable
  assert.ok(store._totalBytes() > TOTAL_STORE_CAP_BYTES); // deliberately still over — unread is never dropped
  assert.equal(store.boxes.size, boxCount);
});

test('pruneOnArchive: drops read and undeliverable mail, keeps the box and its unread mail', () => {
  const store = new MailboxStore(tmpFile());
  const { id: readId } = store.append('rcpt', { from: 'a', body: 'read one' }, 1);
  store.getOne('rcpt', readId);
  store.append('rcpt', { from: 'b', body: 'undeliverable one' }, 2);
  store.markUndeliverable('rcpt');
  const { id: unreadId } = store.append('rcpt', { from: 'c', body: 'unread one' }, 3);

  assert.equal(store.pruneOnArchive('rcpt'), 2);
  const list = store.list('rcpt');
  assert.deepEqual(list.map((m) => m.id), [unreadId]);
  // The box itself survives: a sender was told queued:true, and archive is
  // "set aside" — resume clears archivedAt and the mail is still deliverable.
  assert.equal(store.unreadInfo('rcpt', 4).unread, 1);
});

test('pruneOnArchive: idempotent — a re-archive of an already-archived session drops nothing more', () => {
  const store = new MailboxStore(tmpFile());
  const { id } = store.append('rcpt', { from: 'a', body: 'x' }, 1);
  store.getOne('rcpt', id);
  store.append('rcpt', { from: 'b', body: 'unread' }, 2);
  assert.equal(store.pruneOnArchive('rcpt'), 1);
  assert.equal(store.pruneOnArchive('rcpt'), 0);
  assert.equal(store.list('rcpt').length, 1);
});

test('pruneOnArchive: an archive→resume→archive cycle prunes each live span\'s own read mail', () => {
  const store = new MailboxStore(tmpFile());
  const { id: first } = store.append('rcpt', { from: 'a', body: 'span one' }, 1);
  store.getOne('rcpt', first);
  store.pruneOnArchive('rcpt');
  // Resumed (archivedAt cleared by session-manager) — new mail arrives and is read.
  const { id: second } = store.append('rcpt', { from: 'b', body: 'span two' }, 100);
  store.getOne('rcpt', second);
  assert.equal(store.list('rcpt').length, 1);
  assert.equal(store.pruneOnArchive('rcpt'), 1); // the second span's read mail goes too
  assert.deepEqual(store.list('rcpt'), []);
});

test('pruneOnArchive: unknown recipient is a no-op (never creates a box)', () => {
  const store = new MailboxStore(tmpFile());
  assert.equal(store.pruneOnArchive('nobody'), 0);
  assert.equal(store.boxes.has('nobody'), false);
});

test('pruneOnArchive: persists — the dropped mail does not come back on reload', () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  const { id } = store.append('rcpt', { from: 'a', body: 'x' }, 1);
  store.getOne('rcpt', id);
  store.append('rcpt', { from: 'b', body: 'unread' }, 2);
  store.pruneOnArchive('rcpt');
  assert.equal(new MailboxStore(file).list('rcpt').length, 1);
});

test('expireStaleUnread: drops unread mail older than the cutoff, keeps everything newer', () => {
  const store = new MailboxStore(tmpFile());
  const now = 1_000_000_000_000;
  store.append('rcpt', { from: 'a', body: 'ancient' }, now - UNREAD_TTL_MS - 1);
  const { id: fresh } = store.append('rcpt', { from: 'b', body: 'recent' }, now - 1000);
  assert.equal(store.expireStaleUnread('rcpt', now - UNREAD_TTL_MS), 1);
  assert.deepEqual(store.list('rcpt').map((m) => m.id), [fresh]);
});

test('expireStaleUnread: exactly at the cutoff survives (strictly older expires)', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'on the boundary' }, 500);
  assert.equal(store.expireStaleUnread('rcpt', 500), 0);
  assert.equal(store.list('rcpt').length, 1);
});

test('expireStaleUnread: touches ONLY unread mail — read/undeliverable is pruneOnArchive\'s job, not the TTL\'s', () => {
  const store = new MailboxStore(tmpFile());
  const { id: readId } = store.append('rcpt', { from: 'a', body: 'read long ago' }, 1);
  store.getOne('rcpt', readId, 2);
  store.append('rcpt', { from: 'b', body: 'undeliverable long ago' }, 3);
  store.markUndeliverable('rcpt');
  assert.equal(store.expireStaleUnread('rcpt', 1_000_000), 0);
  assert.equal(store.list('rcpt').length, 2);
});

test('expireStaleUnread: an emptied box goes away, and an unknown recipient never creates one', () => {
  const store = new MailboxStore(tmpFile());
  store.append('rcpt', { from: 'a', body: 'x' }, 1);
  store.takeDueSettles(60_000); // window closed, as mail-runner.js does
  store.expireStaleUnread('rcpt', 1_000_000);
  assert.equal(store.boxes.has('rcpt'), false);
  assert.equal(store.expireStaleUnread('nobody', 1_000_000), 0);
  assert.equal(store.boxes.has('nobody'), false);
});

test('expireStaleUnread: persists', () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  store.append('rcpt', { from: 'a', body: 'old' }, 1);
  store.append('rcpt', { from: 'b', body: 'new' }, 1_000_000);
  store.expireStaleUnread('rcpt', 500_000);
  assert.deepEqual(new MailboxStore(file).list('rcpt').map((m) => m.body), ['new']);
});

// Regression: the per-box floor guarantees a drained batch survives its own
// box's cap, but the WHOLE-STORE cap is a second, independent budget. A store
// pinned over the cap by unread mail has nothing it may evict until a drain
// makes the message it just handed out the only candidate — so the excerpt the
// caller is holding was deleted before it could follow up. Reproduced against
// the pre-fix code: drain returned the message, getOne(id) then returned null.
test('whole-store cap: a message drained seconds ago is NOT evicted out from under its own excerpt follow-up', () => {
  const store = new MailboxStore(tmpFile());
  const boxCount = Math.ceil(TOTAL_STORE_CAP_BYTES / UNREAD_CAP_BYTES) + 1;
  const now = Date.now();
  for (let i = 0; i < boxCount; i++) {
    store.append(`rcpt${i}`, { from: 'a', body: 'x'.repeat(UNREAD_CAP_BYTES - 100) }, now);
  }
  assert.ok(store._totalBytes() > TOTAL_STORE_CAP_BYTES); // pinned over the cap by unread mail

  const drained = store.drain('rcpt0', now);
  assert.equal(drained.length, 1);
  // The read_mail({id}) follow-up the whole retention policy exists for.
  assert.equal(store.getOne('rcpt0', drained[0].id, now)?.body, drained[0].body);
});

test('whole-store cap: once the read grace has passed, that same message IS evictable again', () => {
  const store = new MailboxStore(tmpFile());
  const boxCount = Math.ceil(TOTAL_STORE_CAP_BYTES / UNREAD_CAP_BYTES) + 1;
  const now = Date.now();
  for (let i = 0; i < boxCount; i++) {
    store.append(`rcpt${i}`, { from: 'a', body: 'x'.repeat(UNREAD_CAP_BYTES - 100) }, now);
  }
  store.drain('rcpt0', now);
  // A later mutation, past the grace window: the store is still over the cap,
  // so the now-unprotected read message is what gives.
  store.drain('rcpt1', now + READ_GRACE_MS);
  assert.equal(store.list('rcpt0').length, 0);
});

test('read grace protects only READ mail — undeliverable has no readAt and nothing is waiting to follow up on it', () => {
  const store = new MailboxStore(tmpFile());
  const now = Date.now();
  store.append('rcpt', { from: 'a', body: 'x' }, now);
  store.markUndeliverable('rcpt');
  const m = store.list('rcpt')[0];
  assert.equal(m.readAt, null);
  assert.equal(store._inReadGrace(m, now), false);
});

test('reconcileArchived: batches many recipients into ONE write, dropping evictable and stale unread mail', () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  const now = Date.now();
  const { id: readId } = store.append('a', { from: 'p', body: 'read' }, now - 1000);
  store.getOne('a', readId, now);
  store.append('b', { from: 'p', body: 'stale unread' }, now - UNREAD_TTL_MS - 1);
  store.append('c', { from: 'p', body: 'current unread' }, now);
  store.takeDueSettles(now + SETTLE_MS); // the sweeper has closed every window

  let writes = 0;
  const realSave = store._save.bind(store);
  store._save = () => { writes += 1; realSave(); };
  const dropped = store.reconcileArchived(['a', 'b', 'c'], { staleBefore: now - UNREAD_TTL_MS });

  assert.equal(dropped, 2);
  assert.equal(writes, 1, 'one write for the whole run, not one (or two) per card');
  assert.deepEqual([...store.boxes.keys()], ['c']); // a and b emptied and pruned
  assert.deepEqual(new MailboxStore(file).list('c').map((m) => m.body), ['current unread']);
});

test('reconcileArchived: no staleBefore leaves unread mail alone entirely', () => {
  const store = new MailboxStore(tmpFile());
  store.append('a', { from: 'p', body: 'ancient unread' }, 1);
  assert.equal(store.reconcileArchived(['a']), 0);
  assert.equal(store.list('a').length, 1);
});

test('reconcileArchived: an unknown or already-clean id is a no-op and writes nothing', () => {
  const store = new MailboxStore(tmpFile());
  let writes = 0;
  store._save = () => { writes += 1; };
  assert.equal(store.reconcileArchived(['nobody', 'nor-me']), 0);
  assert.equal(writes, 0);
  assert.equal(store.boxes.size, 0);
});
