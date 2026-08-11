import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverMailNotification } from './mailbox-delivery.js';

function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-maild-'));
}

function deps({ live = {}, entries = {}, resumeThrows = false, resuming = false, resumeTmux = 'cc_joined', resumeReturnsPane = true } = {}) {
  const sent = [];
  const resumed = [];
  const bound = [];
  return {
    sent, resumed, bound,
    sessionManager: {
      entryFor: (id) => entries[id] || null,
      isResuming: () => resuming,
      resume: async (id, dir, opts) => {
        if (resumeThrows) throw new Error('transcript gone');
        resumed.push({ id, dir, opts });
        return resumeReturnsPane ? { tmux: resumeTmux } : {};
      },
    },
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    memoryStore: { bindSession: (id, taskId) => bound.push({ id, taskId }) },
    taskStore: { taskFor: () => null },
    sendText: async (name, text, socket) => { sent.push({ name, text, socket }); },
  };
}

test('live recipient: pastes the notification into the pane, no resume', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'live' });
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'you have mail', socket: '/s/a' }]);
  assert.equal(d.resumed.length, 0);
});

test('live recipient archived during its settle window: skip, never paste — lastGraph can still resolve a tmux for an already-killed card', async () => {
  // Models the race: tmuxFor still resolves a target (lastGraph rebuilds
  // every ~4s, slower than the 2s mail sweep), but the mapping entry already
  // has archivedAt set. The spec requires the re-check "immediately before
  // waking OR notifying" — this is the notifying half.
  const d = deps({
    live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } },
    entries: { CARD1: { archivedAt: Date.now() } },
  });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.sent.length, 0);
});

test('dormant Claude recipient (we OWN the resume): resume carries the notification as the intent, memory bound, no fallback paste', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'claude' };
  const d = deps({ entries: { CARD1: entry } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.equal(d.resumed.length, 1);
  assert.deepEqual(d.resumed[0].opts, { intent: 'you have mail' });
  assert.deepEqual(d.bound, [{ id: 'CARD1', taskId: null }]);
  assert.equal(d.sent.length, 0);
});

test('dormant Codex recipient: resume ignores the intent, so the notification is pasted into the resumed pane', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'codex', socket: '/s/cx' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cx_woken' });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.deepEqual(d.sent, [{ name: 'cx_woken', text: 'you have mail', socket: '/s/cx' }]);
});

test('archived recipient: never woken — no resume, no paste (resurrection-by-mail must not happen)', async () => {
  const dir = realDir();
  const entry = { cwd: dir, archivedAt: Date.now() };
  const d = deps({ entries: { CARD1: entry } });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.resumed.length, 0);
  assert.equal(d.sent.length, 0);
});

test('archive lands DURING the resume await: the fresh re-check aborts, never resume()', async () => {
  const dir = realDir();
  const entries = { CARD1: { cwd: dir, archivedAt: Date.now() } }; // archived by the time the sync block re-reads it
  const d = deps({ entries });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.resumed.length, 0);
});

test('gone recipient (no mapping entry): skip, never resumed', async () => {
  const d = deps({});
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'skip' });
  assert.equal(d.resumed.length, 0);
});

test('coalescing JOIN: a resume already in flight ⇒ notification delivered via post-resume paste', async () => {
  const dir = realDir();
  const entry = { cwd: dir, socket: '/s/z' };
  const d = deps({ entries: { CARD1: entry }, resuming: true, resumeTmux: 'cc_joined' });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.deepEqual(mode, { mode: 'dormant' });
  assert.deepEqual(d.sent, [{ name: 'cc_joined', text: 'you have mail', socket: '/s/z' }]);
});

test('coalescing JOIN with no resulting pane: reported as error, not silently dropped, and carries the real reason', async () => {
  const dir = realDir();
  const entry = { cwd: dir };
  const d = deps({ entries: { CARD1: entry }, resuming: true, resumeReturnsPane: false });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(mode.mode, 'error');
  assert.match(mode.error, /no live pane/);
});

test('resume failure: returns error (with the real failure message, never undefined), never throws', async () => {
  const dir = realDir();
  const entry = { cwd: dir };
  const d = deps({ entries: { CARD1: entry }, resumeThrows: true });
  const mode = await deliverMailNotification('CARD1', 'you have mail', d);
  assert.equal(mode.mode, 'error');
  assert.match(mode.error, /transcript gone/);
});
