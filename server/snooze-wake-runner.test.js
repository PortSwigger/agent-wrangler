import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { dueCommentedSnoozes, wakeCommentedSnooze, fireDueSnoozeWakes, createSnoozeWakeSweeper } from './snooze-wake-runner.js';

const NOW = 1_000_000;

test('dueCommentedSnoozes: only elapsed snoozes that carry a non-empty comment', () => {
  const entries = [
    ['live-elapsed', { snooze: { until: NOW - 1, comment: 'go' } }],
    ['no-comment', { snooze: { until: NOW - 1 } }],           // elapsed, comment-less → ignored
    ['blank-comment', { snooze: { until: NOW - 1, comment: '   ' } }], // whitespace → ignored
    ['future', { snooze: { until: NOW + 1000, comment: 'later' } }],   // not yet due → ignored
    ['unsnoozed', {}],
  ];
  assert.deepEqual(dueCommentedSnoozes(entries, NOW), [{ sessionId: 'live-elapsed', comment: 'go' }]);
});

test('dueCommentedSnoozes: an archived session is never a wake candidate (archive keeps the entry+snooze)', () => {
  const entries = [
    ['archived', { archivedAt: NOW - 100, snooze: { until: NOW - 1, comment: 'do not resurrect' } }],
    ['active', { snooze: { until: NOW - 1, comment: 'still wake me' } }],
  ];
  // The archived+commented+due snooze is excluded; the non-archived one still selects.
  assert.deepEqual(dueCommentedSnoozes(entries, NOW), [{ sessionId: 'active', comment: 'still wake me' }]);
});

function deps(overrides = {}) {
  const calls = { sendText: [], resume: [], bind: [], clear: [] };
  const entry = overrides.entry ?? { snooze: { until: NOW - 1, comment: 'the note' }, cwd: os.tmpdir() };
  return {
    calls,
    entry,
    entries: () => (overrides.entries ?? [['S1', entry]]),
    tmuxFor: overrides.tmuxFor ?? (() => null),
    socketFor: () => 'sockA',
    sendText: async (name, text, socket) => { calls.sendText.push({ name, text, socket }); },
    memoryStore: { bindSession: (sid, tid) => calls.bind.push({ sid, tid }) },
    taskStore: { taskFor: () => ({ id: 'T9' }) },
    sessionManager: {
      entryFor: () => entry,
      resume: async (sid, dir, opts) => { calls.resume.push({ sid, dir, opts }); delete entry.snooze; return { tmux: 'cc_new' }; },
      clearSnooze: (sid) => { calls.clear.push(sid); delete entry.snooze; return true; },
    },
  };
}

test('wake (live): delivers the note via sendText (paste + Enter) and clears the snooze', async () => {
  const d = deps({ tmuxFor: () => 'cc_live' });
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'live');
  assert.deepEqual(d.calls.sendText, [{ name: 'cc_live', text: 'the note', socket: 'sockA' }]);
  assert.deepEqual(d.calls.clear, ['S1']);
  assert.deepEqual(d.calls.resume, []); // a live session is never resumed
});

test('wake (live): CLAIMS the comment (clearSnooze) BEFORE sendText, so a concurrent Unsnooze cannot double-deliver', async () => {
  const order = [];
  const d = deps({ tmuxFor: () => 'cc_live' });
  // Reading the comment from the entry the moment sendText runs must find it gone —
  // the sweep committed to delivering it and cleared it first.
  let commentAtDelivery = 'UNSET';
  d.sessionManager.clearSnooze = (sid) => { order.push('clear'); d.calls.clear.push(sid); delete d.entry.snooze; return true; };
  d.sendText = async (name, text, socket) => {
    order.push('sendText');
    commentAtDelivery = d.entry.snooze?.comment;
    d.calls.sendText.push({ name, text, socket });
  };
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'live');
  assert.deepEqual(order, ['clear', 'sendText'], 'clearSnooze runs before the delivery');
  assert.equal(commentAtDelivery, undefined, 'a concurrent reader finds no comment once the sweep has claimed it');
  assert.deepEqual(d.calls.sendText, [{ name: 'cc_live', text: 'the note', socket: 'sockA' }]); // still delivered from the local copy
});

test('wake (dormant): resumes with intent=comment, binds memory BEFORE resume, then clears', async () => {
  const order = [];
  const d = deps({ tmuxFor: () => null });
  d.memoryStore.bindSession = (sid, tid) => { order.push('bind'); d.calls.bind.push({ sid, tid }); };
  const origResume = d.sessionManager.resume;
  d.sessionManager.resume = async (...a) => { order.push('resume'); return origResume(...a); };
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'dormant');
  // The comment IS the resume intent here (automated path auto-runs it).
  assert.equal(d.calls.resume.length, 1);
  assert.deepEqual(d.calls.resume[0].opts, { intent: 'the note' });
  assert.deepEqual(order, ['bind', 'resume']); // memory bound before relaunch
  assert.deepEqual(d.calls.bind, [{ sid: 'S1', tid: 'T9' }]);
  assert.deepEqual(d.calls.clear, ['S1']); // defensive clear after resume
  assert.deepEqual(d.calls.sendText, []);
});

test('wake: skips (no double-delivery) when the snooze was already cleared by a manual wake', async () => {
  const d = deps({ tmuxFor: () => 'cc_live', entry: { /* no snooze — manually woken already */ cwd: os.tmpdir() } });
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'skip');
  assert.deepEqual(d.calls.sendText, []);
  assert.deepEqual(d.calls.resume, []);
  assert.deepEqual(d.calls.clear, []);
});

// Interleaving — LIVE, MANUAL WINS (sweep side): a human snoozeClearHandler already
// prefilled + claimed this live session. The sweep's own clearSnooze therefore returns
// false; it must skip ENTIRELY — no sendText — so the note isn't pasted a second time.
test('wake (live, manual wins): clearSnooze→false ⇒ skip entirely, no sendText', async () => {
  const d = deps({ tmuxFor: () => 'cc_live' });
  // Comment still readable (the sweep reads before claiming), but the claim loses: a
  // human already removed the snooze between the due-scan and this clearSnooze call.
  d.sessionManager.clearSnooze = (sid) => { d.calls.clear.push(sid); return false; };
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'skip');
  assert.deepEqual(d.calls.clear, ['S1']);  // it attempted the claim
  assert.deepEqual(d.calls.sendText, []);   // but did NOT deliver — the human owns it
  assert.deepEqual(d.calls.resume, []);
});

// Interleaving — DORMANT, MANUAL WINS (sweep side): a human resumeHandler already
// claimed + relaunched-with-prefill this dormant session. The sweep's clearSnooze
// returns false, so it must NOT resume (which would double-relaunch AND re-deliver via
// the intent).
test('wake (dormant, manual wins): clearSnooze→false ⇒ skip entirely, no resume', async () => {
  const d = deps({ tmuxFor: () => null });
  d.sessionManager.clearSnooze = (sid) => { d.calls.clear.push(sid); return false; };
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'skip');
  assert.deepEqual(d.calls.clear, ['S1']);
  assert.deepEqual(d.calls.resume, []);   // no relaunch, no intent delivery
  assert.deepEqual(d.calls.bind, []);     // never even bound memory for the relaunch
  assert.deepEqual(d.calls.sendText, []);
});

// Interleaving — SWEEP WINS (both branches): the sweep's clearSnooze returns true, so it
// owns the single delivery. (The manual side losing the claim is asserted in the resume
// / snooze handler tests.) Live → exactly one sendText; dormant → exactly one resume+intent.
test('wake (live, sweep wins): clearSnooze→true ⇒ delivers exactly once via sendText', async () => {
  const d = deps({ tmuxFor: () => 'cc_live' });
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'live');
  assert.deepEqual(d.calls.clear, ['S1']);
  assert.deepEqual(d.calls.sendText, [{ name: 'cc_live', text: 'the note', socket: 'sockA' }]);
});

test('wake (dormant, sweep wins): clearSnooze→true ⇒ delivers exactly once via resume intent', async () => {
  const d = deps({ tmuxFor: () => null });
  const res = await wakeCommentedSnooze('S1', d);
  assert.equal(res.mode, 'dormant');
  assert.deepEqual(d.calls.clear, ['S1']);
  assert.equal(d.calls.resume.length, 1);
  assert.deepEqual(d.calls.resume[0].opts, { intent: 'the note' });
});

test('fireDueSnoozeWakes: wakes a live commented snooze and reports one woken; ignores comment-less/not-due', async () => {
  const commented = { snooze: { until: NOW - 1, comment: 'do it' }, cwd: os.tmpdir() };
  const bare = { snooze: { until: NOW - 1 }, cwd: os.tmpdir() };       // comment-less → untouched
  const future = { snooze: { until: NOW + 5000, comment: 'x' }, cwd: os.tmpdir() };
  const byId = { A: commented, B: bare, C: future };
  const calls = { sendText: [], clear: [] };
  const d = {
    entries: () => Object.entries(byId),
    tmuxFor: (id) => `cc_${id}`,
    socketFor: () => '',
    sendText: async (name, text) => { calls.sendText.push({ name, text }); },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
    sessionManager: {
      entryFor: (id) => byId[id],
      resume: async () => ({ tmux: 'x' }),
      clearSnooze: (id) => { calls.clear.push(id); delete byId[id].snooze; return true; },
    },
  };
  const woken = await fireDueSnoozeWakes(d, NOW);
  assert.equal(woken, 1);
  assert.deepEqual(calls.sendText, [{ name: 'cc_A', text: 'do it' }]); // only the commented, elapsed one
  assert.deepEqual(calls.clear, ['A']);
  assert.ok(byId.B.snooze, 'comment-less snooze stays put (still amber)');
  assert.ok(byId.C.snooze, 'not-yet-due snooze untouched');
});

test('fireDueSnoozeWakes: a failing wake surfaces an error, clears the snooze (no infinite retry), and does not abort the sweep', async () => {
  const a = { snooze: { until: NOW - 1, comment: 'boom' }, cwd: os.tmpdir() };
  const b = { snooze: { until: NOW - 1, comment: 'ok' }, cwd: os.tmpdir() };
  const byId = { A: a, B: b };
  const cleared = [];
  const errors = [];
  const d = {
    entries: () => Object.entries(byId),
    tmuxFor: (id) => `cc_${id}`,
    socketFor: () => '',
    // A's delivery keeps throwing (a permanently-unresumable session). Note the CLAIM
    // ordering means clearSnooze already ran before sendText threw — we then also clear
    // in the catch (idempotent), and either way A's snooze is gone.
    sendText: async (name) => { if (name === 'cc_A') throw new Error('tmux gone'); },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
    onWakeError: (id, err) => errors.push({ id, message: err.message }),
    sessionManager: {
      entryFor: (id) => byId[id],
      resume: async () => ({ tmux: 'x' }),
      clearSnooze: (id) => { cleared.push(id); delete byId[id].snooze; return true; },
    },
  };
  const woken = await fireDueSnoozeWakes(d, NOW);
  assert.equal(woken, 1);                                   // B still woke despite A throwing
  assert.deepEqual(errors, [{ id: 'A', message: 'tmux gone' }]); // failure surfaced, naming A
  assert.equal(byId.A.snooze, undefined, 'the failed snooze is cleared, not left to retry');
  assert.ok(cleared.includes('A') && cleared.includes('B'));

  // A subsequent tick must NOT retry A (its snooze is gone) — no re-throw, no re-surface.
  errors.length = 0;
  const woken2 = await fireDueSnoozeWakes(d, NOW);
  assert.equal(woken2, 0);
  assert.deepEqual(errors, [], 'the cleared snooze is not re-selected next tick');
});

test('createSnoozeWakeSweeper: a tick arriving mid-sweep is skipped — no concurrent double-wake', async () => {
  let release;
  const gate = new Promise((r) => { release = r; }); // holds the first wake open
  let sendCount = 0;
  let rebuilds = 0;
  const entry = { snooze: { until: NOW - 1, comment: 'go' }, cwd: os.tmpdir() };
  const deps = {
    entries: () => (entry.snooze ? [['S1', entry]] : []),
    tmuxFor: () => 'cc_live',
    socketFor: () => '',
    sendText: async () => { sendCount += 1; await gate; },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
    sessionManager: {
      entryFor: () => entry,
      resume: async () => ({ tmux: 'x' }),
      clearSnooze: () => { delete entry.snooze; return true; },
    },
  };
  const sweep = createSnoozeWakeSweeper(deps, { onWoken: () => { rebuilds += 1; } });

  const first = sweep(NOW);        // starts; parks inside sendText on the gate
  const second = await sweep(NOW); // arrives mid-sweep → must be skipped
  assert.deepEqual(second, { skipped: true });
  assert.equal(sendCount, 1, 'the concurrent tick did not start a second wake');

  release();
  const firstResult = await first;
  assert.deepEqual(firstResult, { skipped: false, woken: 1 });
  assert.equal(sendCount, 1, 'the note was delivered exactly once');
  assert.equal(rebuilds, 1, 'rebuild ran once, only for the sweep that woke a session');

  // The guard is released after the sweep, so a later tick runs normally (nothing due now).
  const third = await sweep(NOW);
  assert.deepEqual(third, { skipped: false, woken: 0 });
});
