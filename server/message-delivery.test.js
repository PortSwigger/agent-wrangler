import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverMessage } from './message-delivery.js';

// A real cwd so resolveResumeDir's existence check operates on a path that's
// actually present — the dormant entry's cwd points here.
function realDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-msgdel-'));
}

// Deps double, mirroring pr-nudge-runner.test.js's shape. `live` is the set of
// managed (attachable) card ids; `entries` maps card id → mapping entry.
// `resuming` makes isResuming() report an in-flight resume (a concurrent manual
// Resume) so we JOIN rather than OWN; `resume` resolves to the joined pane
// (`resumeTmux`, or none to exercise the no-pane error).
function deps({
  live = {}, entries = {}, resumeThrows = false,
  resuming = false, resumeTmux = 'cc_joined', resumeReturnsPane = true,
} = {}) {
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

test('live target: pastes into the pane on its socket, no resume', async () => {
  const d = deps({ live: { CARD1: { tmux: 'cc_one', socket: '/s/a' } } });
  const result = await deliverMessage('CARD1', 'hi there', d);
  assert.deepEqual(result, { mode: 'live' });
  assert.deepEqual(d.sent, [{ name: 'cc_one', text: 'hi there', socket: '/s/a' }]);
  assert.equal(d.resumed.length, 0);
});

test('dormant Claude target (we OWN the resume): resumes with the message as the intent, memory bound, no fallback sendText', async () => {
  const dir = realDir();
  const d = deps({ entries: { CARD1: { cwd: dir, agent: 'claude' } } });
  const result = await deliverMessage('CARD1', 'wake up please', d);
  assert.deepEqual(result, { mode: 'dormant' });
  assert.equal(d.resumed.length, 1);
  assert.equal(d.resumed[0].id, 'CARD1');
  assert.equal(d.resumed[0].dir, dir);
  assert.deepEqual(d.resumed[0].opts, { intent: 'wake up please' });
  assert.deepEqual(d.bound, [{ id: 'CARD1', taskId: null }]);
  assert.equal(d.sent.length, 0); // Claude + owned ⇒ intent carried the message
});

test('dormant Codex target (we OWN the resume): `codex resume` ignores the intent, so the message is delivered via sendText into the resumed pane', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'codex', socket: '/s/cx' };
  const d = deps({ entries: { CARD1: entry }, resumeTmux: 'cx_woken' });
  const result = await deliverMessage('CARD1', 'wake up please', d);
  assert.deepEqual(result, { mode: 'dormant' });
  assert.equal(d.resumed.length, 1);
  assert.deepEqual(d.sent, [{ name: 'cx_woken', text: 'wake up please', socket: '/s/cx' }]);
});

test('dormant target with resume already in flight (JOIN): message delivered via post-resume sendText, not silently dropped', async () => {
  const dir = realDir();
  const entry = { cwd: dir, socket: '/s/z' };
  const d = deps({ entries: { CARD1: entry }, resuming: true, resumeTmux: 'cc_joined' });
  const result = await deliverMessage('CARD1', 'hello', d);
  assert.deepEqual(result, { mode: 'dormant' });
  assert.equal(d.resumed.length, 1); // joined the in-flight resume
  assert.deepEqual(d.sent, [{ name: 'cc_joined', text: 'hello', socket: '/s/z' }]);
});

test('joined resume with no resulting pane: reported as an error, not silently dropped', async () => {
  const dir = realDir();
  const entry = { cwd: dir, socket: '/s/z' };
  const d = deps({ entries: { CARD1: entry }, resuming: true, resumeReturnsPane: false });
  const result = await deliverMessage('CARD1', 'hello', d);
  assert.equal(result.mode, 'error');
  assert.match(result.error, /no live pane/);
  assert.equal(d.sent.length, 0);
});

test('dormant+snoozed target: woken and messaged like any other dormant session (snooze is not a delivery gate)', async () => {
  const dir = realDir();
  const entry = { cwd: dir, agent: 'claude', snooze: { until: Date.now() + 3_600_000, createdAt: Date.now() } };
  const d = deps({ entries: { CARD1: entry } });
  const result = await deliverMessage('CARD1', 'ping', d);
  assert.deepEqual(result, { mode: 'dormant' });
  assert.equal(d.resumed.length, 1);
  assert.deepEqual(d.resumed[0].opts, { intent: 'ping' });
});

test('archived target: refused, never resumed', async () => {
  const dir = realDir();
  const d = deps({ entries: { CARD1: { cwd: dir, archivedAt: Date.now() } } });
  const result = await deliverMessage('CARD1', 'hi', d);
  assert.equal(result.mode, 'error');
  assert.match(result.error, /archived/);
  assert.equal(d.resumed.length, 0);
  assert.equal(d.sent.length, 0);
});

test('gone target (no entry, not live): a clear error, nothing acted on', async () => {
  const d = deps({});
  const result = await deliverMessage('NOPE', 'hi', d);
  assert.equal(result.mode, 'error');
  assert.match(result.error, /not found/);
  assert.equal(d.resumed.length, 0);
});

test('archive lands DURING the resume-dir lookup: fresh re-check aborts, no resurrection', async () => {
  const dir = realDir();
  // The initial entryFor() (not archived) and the later re-check see different
  // snapshots — model a concurrent archive landing between the two reads by
  // returning an archived entry only from the second call onward.
  let calls = 0;
  const entries = {
    get CARD1() { calls += 1; return calls === 1 ? { cwd: dir } : { cwd: dir, archivedAt: Date.now() }; },
  };
  const d = deps({});
  d.sessionManager.entryFor = (id) => entries[id];
  const result = await deliverMessage('CARD1', 'hi', d);
  assert.equal(result.mode, 'error');
  assert.match(result.error, /archived/);
  assert.equal(d.resumed.length, 0);
});

test('resume failure: surfaced as an error, not thrown', async () => {
  const dir = realDir();
  const d = deps({ entries: { CARD1: { cwd: dir } }, resumeThrows: true });
  const result = await deliverMessage('CARD1', 'hi', d); // must not throw
  assert.equal(result.mode, 'error');
  assert.match(result.error, /transcript gone/);
});

test('dormant target: recreates a missing launch dir rather than stranding the resume', async () => {
  const missing = path.join(os.tmpdir(), `aw-msgdel-missing-${process.pid}-${Math.floor(performance.now())}`);
  assert.equal(fs.existsSync(missing), false);
  const d = deps({ entries: { CARD1: { cwd: missing } } });
  await deliverMessage('CARD1', 'hi', d);
  assert.equal(fs.existsSync(missing), true);
  assert.equal(d.resumed[0].dir, missing);
  fs.rmdirSync(missing);
});
