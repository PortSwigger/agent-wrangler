import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snoozeSetHandler, snoozeClearHandler } from './snooze.js';

function ctx(graphSession, { entry = null, clearSnoozeReturns = true } = {}) {
  const calls = { setSnooze: [], clearSnooze: [], suspend: [], pending: [], rebuild: 0, prefill: [], bumpToEnd: [] };
  return {
    calls,
    sessionManager: {
      setSnooze: (sid, until, meta) => calls.setSnooze.push({ sid, until, meta }),
      clearSnooze: (sid) => { calls.clearSnooze.push(sid); return clearSnoozeReturns; },
      suspend: async (sid) => { calls.suspend.push(sid); },
      markSuspendPending: (sid) => { calls.pending.push(sid); },
      entryFor: () => entry,
    },
    taskStore: {
      bumpToEnd: (sid) => calls.bumpToEnd.push(sid),
    },
    sessionFromGraph: () => graphSession ?? null,
    socketFor: () => 'sockZ',
    // Test seam for the C1 live-wake prefill — records (name, text, socket) so we
    // can assert what would be sent, without touching real tmux.
    prefillPane: (name, text, socket) => { calls.prefill.push({ name, text, socket }); return Promise.resolve(); },
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('snooze-set: sets snooze and rebuilds for a valid future timestamp', async () => {
  const until = Date.now() + 10 * 60 * 1000; // 10 min — below the suspend gate
  const c = ctx({ cwd: '/repo', intent: 'work', status: 'idle' });
  await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until }, c);
  assert.equal(c.calls.setSnooze.length, 1);
  assert.equal(c.calls.setSnooze[0].until, until);
  assert.equal(c.calls.rebuild, 1);
});

test('snooze-set: passes graph cwd/intent through (comment undefined when none sent)', async () => {
  const until = Date.now() + 3600_000;
  const c = ctx({ cwd: '/repo', intent: 'work' });
  await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until }, c);
  assert.deepEqual(c.calls.setSnooze[0].meta, { cwd: '/repo', intent: 'work', comment: undefined });
});

test('snooze-set: ignores a past timestamp without rebuilding', async () => {
  const c = ctx(null);
  await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until: Date.now() - 1 }, c);
  assert.equal(c.calls.setSnooze.length, 0);
  assert.equal(c.calls.rebuild, 0);
});

test('snooze-set: ignores a non-finite until value', async () => {
  const c = ctx(null);
  await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until: 'notanumber' }, c);
  assert.equal(c.calls.setSnooze.length, 0);
});

test('snooze-set: threads an optional comment through to setSnooze', async () => {
  const until = Date.now() + 3600_000;
  const c = ctx({ cwd: '/repo', intent: 'work' });
  await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until, comment: 'note on wake' }, c);
  assert.equal(c.calls.setSnooze[0].meta.comment, 'note on wake');
});

test('snooze-clear: clears snooze, bumps it to the end of its stored order, and rebuilds', async () => {
  const c = ctx(null);
  await snoozeClearHandler.handler({ type: 'snooze-clear', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.clearSnooze, ['S1']);
  assert.deepEqual(c.calls.bumpToEnd, ['S1']);
  assert.equal(c.calls.rebuild, 1);
});

test('snooze-clear: a no-op clear (wasn\'t snoozed) does not bump the order', async () => {
  const c = ctx(null, { clearSnoozeReturns: false });
  await snoozeClearHandler.handler({ type: 'snooze-clear', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.clearSnooze, ['S1']);
  assert.deepEqual(c.calls.bumpToEnd, []);
  assert.equal(c.calls.rebuild, 1);
});

test('snooze-clear (C1): a live snoozed session with a note prefills it via send-keys (no Enter), then clears', async () => {
  const c = ctx({ tmux: 'cc_live' }, { entry: { snooze: { until: 1, comment: 'review this' } } });
  await snoozeClearHandler.handler({ type: 'snooze-clear', sessionId: 'S1' }, c);
  // prefillPane (→ send-keys -l, no Enter) receives the note, target pane, and socket.
  assert.deepEqual(c.calls.prefill, [{ name: 'cc_live', text: 'review this', socket: 'sockZ' }]);
  assert.deepEqual(c.calls.clearSnooze, ['S1']);
  assert.equal(c.calls.rebuild, 1);
});

test('snooze-clear: a comment-less live snooze clears with no prefill (behaves exactly as before)', async () => {
  const c = ctx({ tmux: 'cc_live' }, { entry: { snooze: { until: 1 } } });
  await snoozeClearHandler.handler({ type: 'snooze-clear', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.prefill, []);
  assert.deepEqual(c.calls.clearSnooze, ['S1']);
  assert.equal(c.calls.rebuild, 1);
});

test('snooze-clear: a dormant snoozed session (no live pane) never prefills — its note rides the resume path', async () => {
  const c = ctx({ tmux: null }, { entry: { snooze: { until: 1, comment: 'deliver on resume' } } });
  await snoozeClearHandler.handler({ type: 'snooze-clear', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.prefill, []);
  assert.deepEqual(c.calls.clearSnooze, ['S1']);
});

// Interleaving — LIVE, MANUAL WINS: snoozeClearHandler's clearSnooze returns true (it
// removed the snooze), so it owns the delivery and prefills exactly once. A concurrent
// sweep for the same session then sees clearSnooze→false and stands down (runner side).
test('snooze-clear (live, manual wins): clearSnooze→true ⇒ prefills exactly once and bumps', async () => {
  const c = ctx({ tmux: 'cc_live' }, { entry: { snooze: { until: 1, comment: 'human clicked wake' } }, clearSnoozeReturns: true });
  await snoozeClearHandler.handler({ type: 'snooze-clear', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.prefill, [{ name: 'cc_live', text: 'human clicked wake', socket: 'sockZ' }]); // one delivery
  assert.deepEqual(c.calls.clearSnooze, ['S1']);
  assert.deepEqual(c.calls.bumpToEnd, ['S1']);
});

// Interleaving — LIVE, SWEEP WINS: the 30s sweep already claimed this live session
// (clearSnooze→true on its side) and delivered via sendText. When the human's
// snooze-clear then runs, its own clearSnooze returns FALSE (nothing left to remove),
// so it must NOT prefill — otherwise the note pastes twice into the same pane.
test('snooze-clear (live, sweep wins): clearSnooze→false ⇒ does NOT prefill and does NOT bump (no double delivery)', async () => {
  // The entry still carries the comment (the handler reads it before claiming), but the
  // claim loses because the sweep already cleared the snooze in the map.
  const c = ctx({ tmux: 'cc_live' }, { entry: { snooze: { until: 1, comment: 'sweep already sent this' } }, clearSnoozeReturns: false });
  await snoozeClearHandler.handler({ type: 'snooze-clear', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.prefill, []);        // ZERO manual deliveries
  assert.deepEqual(c.calls.clearSnooze, ['S1']); // it tried to claim, but lost
  assert.deepEqual(c.calls.bumpToEnd, []);       // no reorder on a lost claim
  assert.equal(c.calls.rebuild, 1);
});

// The handler never suspends synchronously — it only ever flags suspendPending
// and leaves the actual teardown to the next reconcileSuspend tick, which is the
// single shared eligibility gate (suspendableSessions: idle, unattached, no live
// background shell). That gate is unit-tested in session-manager.test.js; these
// just confirm the handler always defers to it, regardless of current status.
for (const status of ['idle', 'working', 'needs-you']) {
  test(`snooze-set: a >=1h snooze always defers via markSuspendPending, never suspends synchronously (status: ${status})`, async () => {
    const until = Date.now() + 2 * 60 * 60 * 1000;
    const c = ctx({ cwd: '/repo', intent: 'work', status });
    await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until }, c);
    assert.deepEqual(c.calls.pending, ['S1']);
    assert.deepEqual(c.calls.suspend, []);
  });
}

test('snooze-set: a short (<1h) snooze never suspends', async () => {
  const until = Date.now() + 10 * 60 * 1000; // 10 min
  const c = ctx({ cwd: '/repo', intent: 'work', status: 'idle' });
  await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until }, c);
  assert.deepEqual(c.calls.suspend, []);
  assert.deepEqual(c.calls.pending, []);
  assert.equal(c.calls.setSnooze.length, 1);
});

test('snooze-set: a >=1h snooze of an idle session with a live background shell also just defers (the gate handles it)', async () => {
  const until = Date.now() + 2 * 60 * 60 * 1000;
  const c = ctx({ cwd: '/repo', intent: 'work', status: 'idle', hasBackgroundShell: true });
  await snoozeSetHandler.handler({ type: 'snooze-set', sessionId: 'S1', until }, c);
  assert.deepEqual(c.calls.pending, ['S1']);
  assert.deepEqual(c.calls.suspend, []);
});
