import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailboxStore, SETTLE_MS } from './mailbox-store.js';
import { sweepDueSettles, createMailSettleSweeper, createDeferralTracker, DEFER_LOG_AFTER_MS } from './mail-runner.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mailrunner-')), 'mailbox.json');
}
function deps({ mailStore, live = {}, entries = {} } = {}) {
  const sent = [];
  const resumed = [];
  const errors = [];
  return {
    mailStore, sent, resumed, errors,
    sessionManager: {
      entryFor: (id) => entries[id] || (live[id] ? {} : null),
      isResuming: () => false,
      resume: async (id, dir, opts) => { resumed.push({ id, dir, opts }); return { tmux: 'cc_woken' }; },
    },
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    taskStore: { taskFor: () => null },
    mcpSeenAt: () => Date.now(),
    sendText: async (name, text, socket) => { sent.push({ name, text, socket }); },
    // The live announcement goes through paneDeferral; this double records the
    // notification and lets individual tests model a deferred send.
    paneDeferral: {
      deliverOrDefer: async ({ text, tmux, socket }) => { sent.push({ name: tmux, text, socket }); return 'sent'; },
    },
    onError: (to, err) => { errors.push({ to, err }); },
  };
}

test('sweepDueSettles: notifies a live recipient and marks the window notified', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(d.sent.length, 1);
  assert.match(d.sent[0].text, /1 message\. Call read_mail now/);
  assert.equal(d.sent[0].name, 'cc_one');
  assert.ok(store.boxes.get('CARD1').lastNotifiedAt != null);
});

test('sweepDueSettles: fan-in batch — one notification for the whole batch, not one per message', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'one' }, 0);
  store.append('CARD1', { from: 'sess_b', body: 'two' }, 100);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(d.sent.length, 1);
  assert.match(d.sent[0].text, /2 messages\. Call read_mail now/);
});

test('sweepDueSettles: deferred live delivery stays unread and retries the latest batch', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'one' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  const attempted = [];
  let result = 'deferred';
  d.paneDeferral.deliverOrDefer = async ({ text }) => {
    attempted.push(text);
    return result;
  };

  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(store.list('CARD1')[0].state, 'unread');
  assert.equal(store.boxes.get('CARD1').lastNotifiedAt, null);
  assert.equal(store.boxes.get('CARD1').settleDeadline, 2 * SETTLE_MS);

  store.append('CARD1', { from: 'sess_b', body: 'two' }, SETTLE_MS + 1);
  result = 'sent';
  await sweepDueSettles(d, 2 * SETTLE_MS);
  assert.match(attempted[0], /1 message/);
  assert.match(attempted[1], /2 messages/);
  assert.equal(store.boxes.get('CARD1').lastNotifiedAt, 2 * SETTLE_MS);
});

test('sweepDueSettles: persists deferred recipients in one retry update', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'one' }, 0);
  store.append('CARD2', { from: 'sess_b', body: 'two' }, 0);
  const save = store._save.bind(store);
  let saves = 0;
  store._save = () => { saves += 1; save(); };
  const d = deps({
    mailStore: store,
    live: {
      CARD1: { tmux: 'cc_one', socket: '/s/1' },
      CARD2: { tmux: 'cc_two', socket: '/s/2' },
    },
  });
  d.paneDeferral.deliverOrDefer = async () => 'deferred';

  await sweepDueSettles(d, SETTLE_MS);

  assert.equal(saves, 2, 'one save claims due windows and one persists all retry deadlines');
  assert.equal(store.boxes.get('CARD1').settleDeadline, 2 * SETTLE_MS);
  assert.equal(store.boxes.get('CARD2').settleDeadline, 2 * SETTLE_MS);
});

test('sweepDueSettles: not-yet-due recipient is left alone', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  await sweepDueSettles(d, SETTLE_MS - 1);
  assert.equal(d.sent.length, 0);
});

test('sweepDueSettles: recipient archived during the settle window is marked undeliverable, never woken', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, entries: { CARD1: { archivedAt: Date.now() } } });
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(d.sent.length, 0);
  assert.equal(d.resumed.length, 0);
  assert.equal(store.drain('CARD1').length, 0); // never delivered as if it just arrived
  assert.equal(store.getOne('CARD1', store.list('CARD1')[0].id).state, 'undeliverable');
});

test('sweepDueSettles: dormant recipient stays unread until resumed', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, entries: { CARD1: { cwd: '/tmp/session' } } });
  const notified = await sweepDueSettles(d, SETTLE_MS);
  assert.equal(notified, 0);
  assert.equal(d.resumed.length, 0);
  assert.equal(d.sent.length, 0);
  assert.equal(store.list('CARD1')[0].state, 'unread');
  assert.equal(store.boxes.get('CARD1').lastNotifiedAt, null);
  assert.equal(store.boxes.get('CARD1').settleDeadline, 2 * SETTLE_MS);
});

test('sweepDueSettles: a delivery failure is isolated (surfaced via onError) and does not abort the rest of the sweep', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  store.append('CARD2', { from: 'sess_b', body: 'hi' }, 0);
  const d = deps({
    mailStore: store,
    live: { CARD1: { tmux: 'cc_one', socket: '/s/1' }, CARD2: { tmux: 'cc_two', socket: '/s/2' } },
  });
  d.paneDeferral.deliverOrDefer = async ({ id, text, tmux, socket }) => {
    if (id === 'CARD1') throw new Error('tmux gone');
    d.sent.push({ name: tmux, text, socket });
    return 'sent';
  };
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(d.errors.length, 1);
  assert.equal(d.errors[0].to, 'CARD1');
  assert.match(d.errors[0].err.message, /tmux gone/);
  assert.equal(d.sent.length, 1); // CARD2 still got notified
  assert.equal(d.sent[0].name, 'cc_two');
});

test('sweepDueSettles: a deferred delivery re-arms the settle window until the pane is ready', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  let delivery = 'deferred';
  d.paneDeferral.deliverOrDefer = async ({ text, tmux, socket }) => {
    if (delivery === 'deferred') return delivery;
    d.sent.push({ name: tmux, text, socket });
    return 'sent';
  };
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(store.list('CARD1')[0].state, 'unread'); // never dropped, never marked undeliverable
  assert.equal(d.errors.length, 0);

  // A fresh window is open — the next sweep at its new deadline retries.
  const box = store.boxes.get('CARD1');
  assert.equal(box.settleDeadline, SETTLE_MS + SETTLE_MS);
  delivery = 'sent';
  await sweepDueSettles(d, SETTLE_MS + SETTLE_MS);
  assert.equal(store.boxes.get('CARD1').lastNotifiedAt, SETTLE_MS + SETTLE_MS);
});

test('sweepDueSettles: an unexpected throw also re-arms the settle window (not just an explicit error mode)', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  // The live transport is paneDeferral now, so that is what has to throw. (The
  // real one doesn't throw on a dead pane — it queues the line for its own
  // drain, which is a strictly better retry owner than re-arming the window.
  // This pins the surrounding guarantee: whatever the transport throws, the
  // mail is never dropped and the window re-arms.)
  d.paneDeferral = { deliverOrDefer: async () => { throw new Error('tmux gone'); } };
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(store.boxes.get('CARD1').settleDeadline, SETTLE_MS + SETTLE_MS);
  assert.equal(store.list('CARD1')[0].state, 'unread');
});

test('createMailSettleSweeper: an overlapping tick is a no-op (in-flight guard)', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  let deliveries = 0;
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  d.paneDeferral.deliverOrDefer = async () => {
    deliveries += 1;
    await new Promise((r) => setTimeout(r, 20));
    return 'deferred';
  };
  const sweep = createMailSettleSweeper(d);
  const [a, b] = await Promise.all([sweep(SETTLE_MS), sweep(SETTLE_MS)]);
  assert.ok(a.skipped || b.skipped); // exactly one of the two ticks is skipped
  assert.equal(deliveries, 1);
});

test('createMailSettleSweeper reports live notifications', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  const sweep = createMailSettleSweeper(d);
  assert.deepEqual(await sweep(SETTLE_MS), { skipped: false, notified: 1 });
});

test('restart safety: a settle window whose deadline passed while the process was down fires on the first sweep after boot', async () => {
  const file = tmpFile();
  const store = new MailboxStore(file);
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const reloaded = new MailboxStore(file); // simulates a restart
  const d = deps({ mailStore: reloaded, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  await sweepDueSettles(d, SETTLE_MS + 60 * 60 * 1000); // long down
  assert.equal(d.sent.length, 1);
});

test('a mail notification held past a minute is logged once with its reason', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  const logs = [];
  d.log = (line) => logs.push(line);
  let delivery = 'deferred';
  d.paneDeferral.deliverOrDefer = async ({ text, tmux, socket, onDefer }) => {
    if (delivery === 'sent') { d.sent.push({ name: tmux, text, socket }); return 'sent'; }
    onDefer('composer not confirmed empty');
    return 'deferred';
  };
  const sweep = createMailSettleSweeper(d);

  let now = SETTLE_MS;
  for (; now < SETTLE_MS + DEFER_LOG_AFTER_MS; now += SETTLE_MS) await sweep(now);
  assert.deepEqual(logs, []);

  await sweep(now);
  assert.deepEqual(logs, ['[mail] notification to CARD1 deferred 60s: composer not confirmed empty']);
  for (let i = 0; i < 6; i += 1) { now += SETTLE_MS; await sweep(now); }
  assert.equal(logs.length, 1);

  delivery = 'sent';
  now += SETTLE_MS;
  await sweep(now);
  assert.equal(d.sent.length, 1);

  store.append('CARD1', { from: 'sess_a', body: 'again' }, now);
  delivery = 'deferred';
  const restart = now + SETTLE_MS;
  for (now = restart; now <= restart + DEFER_LOG_AFTER_MS; now += SETTLE_MS) await sweep(now);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /deferred 60s: composer not confirmed empty/);
});

test('a deferral tracker starts a fresh episode after a quiet gap', () => {
  const logs = [];
  const t = createDeferralTracker({ log: (line) => logs.push(line) });
  t.deferred('CARD1', 'no tmux target', 0);
  t.deferred('CARD1', 'no tmux target', 20_000);
  t.deferred('CARD1', 'no tmux target', 60_000);
  t.deferred('CARD1', 'no tmux target', 70_000);
  assert.deepEqual(logs, [], 'the 40s gap before 60s started a new episode');
  t.deferred('CARD1', 'pane classified working', 95_000);
  t.deferred('CARD1', 'pane classified working', 120_000);
  assert.deepEqual(logs, ['[mail] notification to CARD1 deferred 60s: pane classified working']);
});

test('mail arriving after a read_mail drain starts a fresh deferral episode', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'first' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  const logs = [];
  d.log = (line) => logs.push(line);
  d.paneDeferral.deliverOrDefer = async ({ onDefer }) => { onDefer('pane classified working'); return 'deferred'; };
  const sweep = createMailSettleSweeper(d);

  let now = SETTLE_MS;
  for (; now <= SETTLE_MS + DEFER_LOG_AFTER_MS; now += SETTLE_MS) await sweep(now);
  assert.equal(logs.length, 1);

  store.drain('CARD1', now);
  store.append('CARD1', { from: 'sess_a', body: 'second' }, now);
  for (let i = 0; i < 6; i += 1) { await sweep(now); now += SETTLE_MS; }
  assert.equal(logs.length, 1, 'the new batch has only been held 50s');
  await sweep(now);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /deferred 60s: pane classified working/);
});

test('a batch read before its log does not hand its start time to the next batch', () => {
  const logs = [];
  const t = createDeferralTracker({ log: (line) => logs.push(line) });
  t.deferred('CARD1', 'pane classified working', 0, ['mail_a']);
  t.deferred('CARD1', 'pane classified working', 25_000, ['mail_a']);
  t.deferred('CARD1', 'pane classified working', 50_000, ['mail_b']);
  t.deferred('CARD1', 'pane classified working', 70_000, ['mail_b']);
  assert.deepEqual(logs, []);
});

test('reading part of a held batch keeps its deferral episode running', () => {
  const logs = [];
  const t = createDeferralTracker({ log: (line) => logs.push(line) });
  t.deferred('CARD1', 'pane classified working', 0, ['mail_a', 'mail_b']);
  t.deferred('CARD1', 'pane classified working', 25_000, ['mail_a', 'mail_b']);
  t.deferred('CARD1', 'pane classified working', 50_000, ['mail_b', 'mail_c']);
  assert.deepEqual(logs, []);
  t.deferred('CARD1', 'pane classified working', 60_000, ['mail_c']);
  assert.deepEqual(logs, ['[mail] notification to CARD1 deferred 60s: pane classified working']);
});
