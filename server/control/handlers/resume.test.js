import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { resumeHandler, waitForPaneReady, deliverWakeNote } from './resume.js';

// waitForPaneReady: hooks the post-resume prefill to a readiness signal (the pane's
// OSC title landing) rather than a blind sleep, and is bounded. Deps injected so
// this never touches real tmux or real timers.
test('waitForPaneReady: resolves true as soon as the title signals ready', async () => {
  const ready = await waitForPaneReady('cc_x', '', {
    titleFn: async () => '✳ resumed session',
    sleep: async () => { throw new Error('should not sleep — ready on first poll'); },
  });
  assert.equal(ready, true);
});

test('waitForPaneReady: polls a booting pane until its title lands', async () => {
  let polls = 0;
  const ready = await waitForPaneReady('cc_x', '', {
    timeoutMs: 10_000,
    pollMs: 1,
    titleFn: async () => { polls += 1; return polls < 3 ? 'hostname.local' : '✳ up now'; },
    sleep: async () => {},
  });
  assert.equal(ready, true);
  assert.equal(polls, 3);
});

test('waitForPaneReady: gives up (false) once the deadline passes, so delivery is never blocked forever', async () => {
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const ready = await waitForPaneReady('cc_x', '', {
      timeoutMs: 5,
      pollMs: 10,
      titleFn: async () => 'hostname.local', // never Claude's glyph title (e.g. Codex)
      sleep: async (ms) => { now += ms; },
    });
    assert.equal(ready, false);
  } finally {
    Date.now = realNow;
  }
});

// deliverWakeNote: waits for readiness THEN prefills (never before), delivers the
// note verbatim, and no-ops without a note or a live pane.
test('deliverWakeNote: waits for readiness before prefilling, then delivers the note (no Enter — prefill only)', async () => {
  const order = [];
  const delivered = await deliverWakeNote('cc_new', 'sockA', 'finish the migration', {
    waitReady: async () => { order.push('ready'); },
    prefill: async (name, text, socket) => { order.push({ prefill: { name, text, socket } }); },
  });
  assert.equal(delivered, true);
  assert.deepEqual(order, ['ready', { prefill: { name: 'cc_new', text: 'finish the migration', socket: 'sockA' } }]);
});

test('deliverWakeNote: no-op when there is no note or no live pane', async () => {
  let touched = false;
  const deps = { waitReady: async () => { touched = true; }, prefill: async () => { touched = true; } };
  assert.equal(await deliverWakeNote('cc_new', '', '', deps), false);
  assert.equal(await deliverWakeNote(null, '', 'a note', deps), false);
  assert.equal(touched, false);
});

// Handler-level C2: a dormant wake resumes normally (note NOT passed as the resume
// intent, which would auto-run it) and delivers the note AFTER resume rebuilds the
// entry. Crucially the note is captured BEFORE resume, since resumeEntry drops
// entry.snooze — the resume spy simulates that drop.
function handlerCtx(entry, { graphCwd = os.tmpdir(), clearReturns = true } = {}) {
  const calls = { resume: [], ready: [], prefill: [], rebuild: 0, clear: [] };
  return {
    calls,
    sessionFromGraph: () => ({ sessionId: 'S1', cwd: graphCwd }),
    sessionManager: {
      entryFor: () => entry,
      // clearSnooze is the atomic delivery claim. When clearReturns is false it models
      // the sweep having already claimed (and relaunched-with-intent) this session —
      // the entry.snooze is gone, so the manual side must NOT deliver again.
      clearSnooze: (sid) => { calls.clear.push(sid); delete entry.snooze; return clearReturns; },
      resume: async (sid, dir, opts) => {
        calls.resume.push({ sid, dir, opts });
        delete entry.snooze; // resumeEntry rebuilds the entry without the snooze
        return { tmux: 'cc_new' };
      },
    },
    memoryStore: { bindSession: () => {} },
    taskStore: { taskFor: () => null },
    reply: () => {},
    rebuild: async () => { calls.rebuild += 1; },
    // Test seams (undefined in prod → deliverWakeNote's real tmux impls).
    waitForPaneReady: async (name, socket) => { calls.ready.push({ name, socket }); },
    prefillPane: async (name, text, socket) => { calls.prefill.push({ name, text, socket }); },
  };
}

test('resume (C2): reads the snooze note before resume, resumes WITHOUT an intent, then prefills after readiness', async () => {
  const entry = { cwd: os.tmpdir(), socket: 'sockR', liveSessionId: null, snooze: { until: 1, comment: 'pick up where we left off' } };
  const c = handlerCtx(entry);
  await resumeHandler.handler({ type: 'resume', sessionId: 'S1' }, c);
  // Resumed with no intent — the note must not be auto-run via `-- <prompt>`.
  assert.equal(c.calls.resume.length, 1);
  assert.equal(c.calls.resume[0].opts, undefined);
  // Readiness gate ran, then the note was prefilled into the fresh pane — with the
  // value captured before resume dropped entry.snooze.
  assert.deepEqual(c.calls.ready, [{ name: 'cc_new', socket: 'sockR' }]);
  assert.deepEqual(c.calls.prefill, [{ name: 'cc_new', text: 'pick up where we left off', socket: 'sockR' }]);
  assert.equal(entry.snooze, undefined); // resume dropped it, but delivery still fired
});

// killJobsFirst with no live pane (s.tmux absent) short-circuits the nudge/wait —
// same guard as archiveHandler's — and resumes normally. (The live-tmux nudge path
// hits real tmux, so like archive.test.js it isn't unit-tested at the handler level;
// waitForBackgroundShellClear itself is covered directly in archive.test.js.)
test('resume: killJobsFirst with no live tmux skips the nudge and resumes', async () => {
  const entry = { cwd: os.tmpdir(), socket: 'sockR' };
  const c = handlerCtx(entry);
  await resumeHandler.handler({ type: 'resume', sessionId: 'S1', killJobsFirst: true }, c);
  assert.equal(c.calls.resume.length, 1);
  assert.equal(c.calls.rebuild, 1);
});

test('resume: a note-less dormant wake resumes and never prefills', async () => {
  const entry = { cwd: os.tmpdir(), socket: 'sockR', snooze: { until: 1 } };
  const c = handlerCtx(entry);
  await resumeHandler.handler({ type: 'resume', sessionId: 'S1' }, c);
  assert.equal(c.calls.resume.length, 1);
  assert.deepEqual(c.calls.ready, []);
  assert.deepEqual(c.calls.prefill, []);
  assert.equal(c.calls.rebuild, 1);
});

// Interleaving — DORMANT, MANUAL WINS: resumeHandler claims the note (clearSnooze
// returns true, BEFORE resume) and delivers it via prefill. A subsequent sweep for the
// same session will see clearSnooze→false and stand down (covered on the runner side).
// Exactly one delivery, via the prefill.
test('resume (dormant, manual wins): claims via clearSnooze BEFORE resume, then delivers exactly once', async () => {
  const entry = { cwd: os.tmpdir(), socket: 'sockR', liveSessionId: null, snooze: { until: 1, comment: 'human woke me' } };
  const c = handlerCtx(entry, { clearReturns: true });
  await resumeHandler.handler({ type: 'resume', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.clear, ['S1']);      // we claimed it
  assert.equal(c.calls.resume.length, 1);
  assert.deepEqual(c.calls.prefill, [{ name: 'cc_new', text: 'human woke me', socket: 'sockR' }]); // one delivery
});

// Interleaving — DORMANT, SWEEP WINS: the 30s auto-wake sweep already claimed this
// session and relaunched it with the note as the resume intent. When the human's
// resumeHandler then runs, its clearSnooze returns false (snooze already gone), so it
// resumes (joining/re-relaunching is coalesced elsewhere) but must NOT deliverWakeNote —
// otherwise the note lands twice (once via the sweep's intent, once via this prefill).
test('resume (dormant, sweep wins): clearSnooze→false ⇒ resumes but does NOT prefill (no double delivery)', async () => {
  const entry = { cwd: os.tmpdir(), socket: 'sockR', liveSessionId: null, snooze: { until: 1, comment: 'sweep already sent this' } };
  const c = handlerCtx(entry, { clearReturns: false });
  await resumeHandler.handler({ type: 'resume', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.clear, ['S1']);   // it tried to claim, but lost
  assert.equal(c.calls.resume.length, 1);
  assert.deepEqual(c.calls.ready, []);       // readiness gate never runs
  assert.deepEqual(c.calls.prefill, []);     // ZERO manual deliveries — the sweep's intent already delivered it
});
