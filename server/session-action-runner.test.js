import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSessionAction } from './session-action-runner.js';

// A real cwd so resolveResumeDir's existence check (and the runner's mkdir
// fallback) operate on a path that's actually present — entry.cwd points here.
function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sar-'));
}

// Deps double. `live` is the set of managed (attachable) card ids; `entries` maps
// card id → mapping entry (a dormant session has an entry but isn't live).
function deps({ live = {}, entries = {}, sent = [], resumed = [], bound = [] } = {}) {
  return {
    sent, resumed, bound,
    sessionManager: {
      entryFor: (id) => entries[id] || null,
      resume: async (id, dir, opts) => { resumed.push({ id, dir, opts }); },
    },
    tmuxFor: (id) => live[id]?.tmux ?? null,
    socketFor: (id) => live[id]?.socket ?? '',
    memoryStore: { bindSession: (id, taskId) => bound.push({ id, taskId }) },
    taskStore: { taskFor: (id) => (id === 'CARD_T' ? { id: 'T9' } : null) },
    sendText: async (name, text, socket) => { sent.push({ name, text, socket }); },
  };
}

test('session, live target + message: injects the text into the pane on its socket (no resume)', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } }, entries: { CARD1: { cwd: '/x' } } });
  const out = await runSessionAction({ kind: 'session', sessionId: 'CARD1', message: 'ping' }, d);
  assert.deepEqual(out, { sessionId: 'CARD1' });
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'ping', socket: '/s/a' }]);
  assert.equal(d.resumed.length, 0); // a live session is never torn down to "resume" it
});

test('session, live target + no message: no-op success (nothing delivered, not an error)', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } }, entries: { CARD1: { cwd: '/x' } } });
  const out = await runSessionAction({ kind: 'session', sessionId: 'CARD1', message: '' }, d);
  assert.deepEqual(out, { sessionId: 'CARD1' });
  assert.equal(d.sent.length, 0);
  assert.equal(d.resumed.length, 0);
});

test('session, dormant target + message: resumes, binds memory pre-launch, passes the message as the relaunch intent', async () => {
  const dir = realDir();
  const d = deps({ entries: { CARD_T: { cwd: dir } } }); // has an entry, not live
  const out = await runSessionAction({ kind: 'session', sessionId: 'CARD_T', message: 'check CI' }, d);
  assert.deepEqual(out, { sessionId: 'CARD_T' });
  assert.deepEqual(d.bound, [{ id: 'CARD_T', taskId: 'T9' }]); // memory bound to the resolved task
  assert.equal(d.resumed.length, 1);
  assert.equal(d.resumed[0].id, 'CARD_T');
  assert.equal(d.resumed[0].dir, dir);
  assert.deepEqual(d.resumed[0].opts, { intent: 'check CI' });
  assert.equal(d.sent.length, 0); // dormant ⇒ resume, never sendText
});

test('session, dormant target + no message: plain resume (empty intent)', async () => {
  const dir = realDir();
  const d = deps({ entries: { CARD1: { cwd: dir } } });
  await runSessionAction({ kind: 'session', sessionId: 'CARD1' }, d);
  assert.equal(d.resumed.length, 1);
  assert.deepEqual(d.resumed[0].opts, { intent: '' });
});

test('session, gone target (no entry, not live): throws a clear error, nothing acted on', async () => {
  const d = deps({});
  await assert.rejects(() => runSessionAction({ kind: 'session', sessionId: 'NOPE', message: 'hi' }, d), /not found/);
  assert.equal(d.resumed.length, 0);
  assert.equal(d.sent.length, 0);
});

test('session, dormant target: recreates a missing launch dir rather than stranding the resume', async () => {
  const missing = path.join(os.tmpdir(), `aw-sar-missing-${process.pid}-${Math.floor(performance.now())}`);
  assert.equal(fs.existsSync(missing), false);
  const d = deps({ entries: { CARD1: { cwd: missing } } });
  await runSessionAction({ kind: 'session', sessionId: 'CARD1' }, d);
  assert.equal(fs.existsSync(missing), true);
  assert.equal(d.resumed[0].dir, missing);
  fs.rmdirSync(missing);
});

test('unknown action kind throws', async () => {
  await assert.rejects(() => runSessionAction({ kind: 'frob', sessionId: 'CARD1' }, deps({})), /Unknown schedule action/);
});
