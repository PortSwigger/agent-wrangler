import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MailboxStore, SETTLE_MS } from './mailbox-store.js';
import { sweepDueSettles, createMailSettleSweeper } from './mail-runner.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mailrunner-')), 'mailbox.json');
}
function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-mailrunner-dir-'));
}

function deps({ mailStore, live = {}, entries = {} } = {}) {
  const sent = [];
  const resumed = [];
  const errors = [];
  return {
    mailStore, sent, resumed, errors,
    sessionManager: {
      entryFor: (id) => entries[id] || null,
      isResuming: () => false,
      resume: async (id, dir, opts) => { resumed.push({ id, dir, opts }); return { tmux: 'cc_woken' }; },
    },
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
    sendText: async (name, text, socket) => { sent.push({ name, text, socket }); },
    // Models a TUI that's already ready (real classify()'s "esc to interrupt"
    // working marker shows up as soon as anything is pasted), so the
    // dormant-Codex post-resume paste lands on the first attempt
    // (mailbox-delivery.js's pasteAndVerify) rather than falling back to a real
    // (and here nonexistent) tmux pane and burning the real retry delay.
    capturePane: async (name) => (sent.some((s) => s.name === name) ? 'esc to interrupt' : ''),
    pasteVerifyDelayMs: 0,
    pasteVerifyPollMs: 0,
    onError: (to, err) => { errors.push({ to, err }); },
  };
}

test('sweepDueSettles: notifies a live recipient and marks the window notified', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(d.sent.length, 1);
  assert.match(d.sent[0].text, /1 message, read when convenient\./);
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
  assert.match(d.sent[0].text, /2 messages, read when convenient\./);
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

test('sweepDueSettles: dormant recipient is woken and returns a count for the caller to rebuild on', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const dir = realDir();
  const d = deps({ mailStore: store, entries: { CARD1: { cwd: dir, agent: 'claude' } } });
  const woken = await sweepDueSettles(d, SETTLE_MS);
  assert.equal(woken, 1);
  assert.equal(d.resumed.length, 1);
});

test('sweepDueSettles: a delivery failure is isolated (surfaced via onError) and does not abort the rest of the sweep', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  store.append('CARD2', { from: 'sess_b', body: 'hi' }, 0);
  const dir = realDir();
  // CARD1: dormant + resume that produces no live pane ⇒ 'error' mode from the delivery leg.
  const d = deps({
    mailStore: store,
    live: { CARD2: { tmux: 'cc_two', socket: '/s' } },
    entries: { CARD1: { cwd: dir, agent: 'codex' } }, // codex ignores intent; resume returns tmux via deps.sessionManager.resume mock which DOES return tmux — force error via override below
  });
  d.sessionManager.resume = async () => ({}); // no tmux on the resumed pane ⇒ 'error'
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(d.errors.length, 1);
  assert.equal(d.errors[0].to, 'CARD1');
  assert.match(d.errors[0].err.message, /no live pane/); // the real failure reason, not undefined
  assert.equal(d.sent.length, 1); // CARD2 still got notified
  assert.equal(d.sent[0].name, 'cc_two');
});

test('sweepDueSettles: a failed delivery re-arms the settle window — the batch is retried, not stranded unread forever', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const dir = realDir();
  const d = deps({ mailStore: store, entries: { CARD1: { cwd: dir, agent: 'codex' } } });
  d.sessionManager.resume = async () => ({}); // 'error' mode
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(store.list('CARD1')[0].state, 'unread'); // never dropped, never marked undeliverable
  assert.equal(d.errors.length, 1);

  // A fresh window is open — the next sweep at its new deadline retries.
  const box = store.boxes.get('CARD1');
  assert.equal(box.settleDeadline, SETTLE_MS + SETTLE_MS);
  d.sessionManager.resume = async () => ({ tmux: 'cc_recovered' }); // now it succeeds
  await sweepDueSettles(d, SETTLE_MS + SETTLE_MS);
  assert.equal(store.boxes.get('CARD1').lastNotifiedAt, SETTLE_MS + SETTLE_MS);
});

test('sweepDueSettles: an unexpected throw also re-arms the settle window (not just an explicit error mode)', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  d.sendText = async () => { throw new Error('tmux gone'); };
  await sweepDueSettles(d, SETTLE_MS);
  assert.equal(store.boxes.get('CARD1').settleDeadline, SETTLE_MS + SETTLE_MS);
  assert.equal(store.list('CARD1')[0].state, 'unread');
});

test('createMailSettleSweeper: an overlapping tick is a no-op (in-flight guard)', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const dir = realDir();
  let resumeCalls = 0;
  const d = deps({ mailStore: store, entries: { CARD1: { cwd: dir, agent: 'claude' } } });
  const realResume = d.sessionManager.resume;
  d.sessionManager.resume = async (...args) => {
    resumeCalls += 1;
    await new Promise((r) => setTimeout(r, 20)); // slow dormant wake
    return realResume(...args);
  };
  const sweep = createMailSettleSweeper(d);
  const [a, b] = await Promise.all([sweep(SETTLE_MS), sweep(SETTLE_MS)]);
  assert.ok(a.skipped || b.skipped); // exactly one of the two ticks is skipped
  assert.equal(resumeCalls, 1); // never resumed twice
});

test('createMailSettleSweeper: onWoken fires only when a dormant wake actually happened', async () => {
  const store = new MailboxStore(tmpFile());
  store.append('CARD1', { from: 'sess_a', body: 'hi' }, 0);
  const d = deps({ mailStore: store, live: { CARD1: { tmux: 'cc_one', socket: '/s' } } });
  let woke = false;
  const sweep = createMailSettleSweeper(d, { onWoken: () => { woke = true; } });
  await sweep(SETTLE_MS);
  assert.equal(woke, false); // live-only sweep, nothing dormant
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
