import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveHandler, waitForBackgroundShellClear, KILL_JOBS_NUDGE, descendantsOf, archiveCascade, containerStillInUse, stopContainerHandler } from './archive.js';

function ctx(graphSession, overrides = {}) {
  const calls = { kill: [], archive: [], reply: [] };
  return {
    calls,
    sessionManager: {
      killForSession: async (sid) => { calls.kill.push(sid); return overrides.killed ?? []; },
      archive: (sid, meta) => calls.archive.push({ sid, meta }),
    },
    taskStore: { taskFor: (sid) => overrides.task ?? null },
    sessionFromGraph: () => graphSession ?? null,
    rebuild: async () => {},
    reply: (obj) => calls.reply.push(obj),
  };
}

// A ctx resolving MULTIPLE distinct sessions by id (unlike ctx() above, which
// always returns the same one) — for cascade tests walking a parentSession tree.
function cascadeCtx(sessions) {
  const calls = { kill: [], archive: [], reply: [] };
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  return {
    calls,
    sessionManager: {
      killForSession: async (sid) => { calls.kill.push(sid); return []; },
      archive: (sid, meta) => calls.archive.push({ sid, meta }),
    },
    taskStore: { taskFor: () => null },
    sessionFromGraph: (sid) => byId.get(sid) ?? null,
    graph: () => ({ sessions }),
    tmuxFor: (sid) => byId.get(sid)?.tmux ?? null,
    socketFor: () => '',
    rebuild: async () => {},
    reply: (obj) => calls.reply.push(obj),
  };
}

test('archive: kills the session and archives it with graph metadata', async () => {
  const c = ctx({ cwd: '/repo', intent: 'do work', label: 'My session' });
  await archiveHandler.handler({ type: 'archive', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.kill, ['S1']);
  assert.equal(c.calls.archive.length, 1);
  assert.equal(c.calls.archive[0].sid, 'S1');
  assert.equal(c.calls.archive[0].meta.cwd, '/repo');
  assert.equal(c.calls.archive[0].meta.intent, 'do work');
  assert.equal(c.calls.archive[0].meta.label, 'My session');
});

test('archive: falls back to label when intent is absent', async () => {
  const c = ctx({ cwd: '/repo', label: 'Fallback label' });
  await archiveHandler.handler({ type: 'archive', sessionId: 'S1' }, c);
  assert.equal(c.calls.archive[0].meta.intent, 'Fallback label');
});

test('archive: proceeds when killForSession throws (process already gone)', async () => {
  const c = ctx(null);
  c.sessionManager.killForSession = async () => { throw new Error('gone'); };
  await assert.doesNotReject(archiveHandler.handler({ type: 'archive', sessionId: 'S1' }, c));
  assert.equal(c.calls.archive.length, 1);
});

test('archive: archives even when the session is off-graph', async () => {
  const c = ctx(null);
  await archiveHandler.handler({ type: 'archive', sessionId: 'S1' }, c);
  assert.equal(c.calls.archive.length, 1);
  assert.equal(c.calls.archive[0].meta.cwd, undefined);
});

test('archive: a plain archive never replies (only killJobsFirst does)', async () => {
  const c = ctx({ cwd: '/repo', label: 'x' });
  await archiveHandler.handler({ type: 'archive', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.reply, []);
});

test('archive: killJobsFirst with no live tmux skips the nudge/wait and archives, reporting clean', async () => {
  const c = ctx({ cwd: '/repo', label: 'x', tmux: null });
  await archiveHandler.handler({ type: 'archive', sessionId: 'S1', killJobsFirst: true }, c);
  assert.equal(c.calls.archive.length, 1);
  assert.deepEqual(c.calls.reply, [{ type: 'archived', sessionId: 'S1', unclean: false }]);
});

test('archive: killJobsFirst with no live tmux still archives cleanly for a codex agent (same no-op short-circuit)', async () => {
  const c = ctx({ cwd: '/repo', label: 'x', agent: 'codex', tmux: null });
  await archiveHandler.handler({ type: 'archive', sessionId: 'S1', killJobsFirst: true }, c);
  assert.equal(c.calls.archive.length, 1);
  assert.deepEqual(c.calls.reply, [{ type: 'archived', sessionId: 'S1', unclean: false }]);
});

test('KILL_JOBS_NUDGE has distinct wording for claude and codex (no dedicated kill tool for codex)', () => {
  assert.match(KILL_JOBS_NUDGE.claude, /KillShell/);
  assert.doesNotMatch(KILL_JOBS_NUDGE.codex, /KillShell/);
  assert.notEqual(KILL_JOBS_NUDGE.claude, KILL_JOBS_NUDGE.codex);
});

// Shared by archive (solo + cascade) and restart, so the wording must stay NEUTRAL —
// naming one specific teardown ("archived"/"restarted") would be wrong for the others.
test('KILL_JOBS_NUDGE is teardown-neutral (names neither archive nor restart)', () => {
  for (const agent of ['claude', 'codex']) {
    assert.doesNotMatch(KILL_JOBS_NUDGE[agent], /archiv|restart/i, `${agent} nudge should not name a specific teardown`);
  }
});

test('waitForBackgroundShellClear: resolves true as soon as the shell marker is gone', async () => {
  const cleared = await waitForBackgroundShellClear('cc_x', '', {
    capturePaneFn: async () => 'pane text',
    detectFn: () => false,
    sleep: async () => { throw new Error('should not sleep'); },
  });
  assert.equal(cleared, true);
});

test('waitForBackgroundShellClear: polls until it clears, within the timeout', async () => {
  let calls = 0;
  const cleared = await waitForBackgroundShellClear('cc_x', '', {
    timeoutMs: 10_000,
    pollMs: 1,
    capturePaneFn: async () => 'pane text',
    detectFn: () => { calls += 1; return calls < 3; }, // clears on the 3rd poll
    sleep: async () => {},
  });
  assert.equal(cleared, true);
  assert.equal(calls, 3);
});

test('waitForBackgroundShellClear: default detectFn is agent-aware (codex marker clears, no override needed)', async () => {
  let calls = 0;
  const cleared = await waitForBackgroundShellClear('cc_x', '', {
    agent: 'codex',
    timeoutMs: 10_000,
    pollMs: 1,
    // Real capturePane is not injected here — only capturePaneFn is, so this stays
    // a pure test of the default detectFn's agent wiring, not a real tmux call.
    capturePaneFn: async () => { calls += 1; return calls < 2 ? '1 background terminal running · /ps to view · /stop to close' : 'idle, nothing running'; },
    sleep: async () => {},
  });
  assert.equal(cleared, true);
  assert.equal(calls, 2);
});

test('descendantsOf: walks the transitive parentSession chain, not just direct children', () => {
  const sessions = [
    { sessionId: 'ORCH' },
    { sessionId: 'C1', parentSession: 'ORCH' },
    { sessionId: 'GC1', parentSession: 'C1' },
    { sessionId: 'OTHER' },
  ];
  assert.deepEqual(descendantsOf('ORCH', sessions).map((s) => s.sessionId), ['C1', 'GC1']);
});

test('descendantsOf: no descendants → empty array', () => {
  assert.deepEqual(descendantsOf('X', [{ sessionId: 'X' }]), []);
});

test('archiveCascade: archives every id in order, using each session\'s OWN hasBackgroundShell (no tmux → clean, nothing to nudge)', async () => {
  const sessions = [
    { sessionId: 'C1', cwd: '/x', label: 'Child', hasBackgroundShell: true, tmux: null },
    { sessionId: 'ORCH', cwd: '/x', label: 'Orch' },
  ];
  const c = cascadeCtx(sessions);
  const { unclean } = await archiveCascade(['C1', 'ORCH'], c);
  assert.equal(unclean, false);
  assert.deepEqual(c.calls.kill, ['C1', 'ORCH']);
  assert.deepEqual(c.calls.archive.map((a) => a.sid), ['C1', 'ORCH']);
});

test('archiveCascade: viaTaskArchive stamps every archived session\'s snapshot, omitted entirely without it', async () => {
  const sessions = [
    { sessionId: 'C1', cwd: '/x', label: 'Child' },
    { sessionId: 'C2', cwd: '/x', label: 'Child2' },
  ];
  const c = cascadeCtx(sessions);
  await archiveCascade(['C1', 'C2'], c, { viaTaskArchive: 'T1' });
  assert.deepEqual(c.calls.archive.map((a) => a.meta.viaTaskArchive), ['T1', 'T1']);

  // Without the opt (the plain descendant-cascade path), the key is absent —
  // not just falsy — so the snapshot shape is unchanged for every other caller.
  const c2 = cascadeCtx(sessions);
  await archiveCascade(['C1', 'C2'], c2);
  assert.deepEqual(c2.calls.archive.map((a) => 'viaTaskArchive' in a.meta), [false, false]);
});

test('archive: cascade archives descendants first, then the target, in one handler call', async () => {
  const sessions = [
    { sessionId: 'ORCH', cwd: '/x', label: 'Orch' },
    { sessionId: 'C1', cwd: '/x', label: 'Child', parentSession: 'ORCH' },
    { sessionId: 'GC1', cwd: '/x', label: 'Grandchild', parentSession: 'C1' },
  ];
  const c = cascadeCtx(sessions);
  await archiveHandler.handler({ type: 'archive', sessionId: 'ORCH', cascade: true, killJobsFirst: true }, c);
  assert.deepEqual(c.calls.archive.map((a) => a.sid), ['C1', 'GC1', 'ORCH']);
  assert.deepEqual(c.calls.reply, [{ type: 'archived', sessionId: 'ORCH', unclean: false, archivedChildren: 2, childIds: ['C1', 'GC1'] }]);
});

test('archive: cascade always replies, even without killJobsFirst — the client needs to know the whole tree is down', async () => {
  const sessions = [
    { sessionId: 'ORCH', cwd: '/x', label: 'Orch' },
    { sessionId: 'C1', cwd: '/x', label: 'Child', parentSession: 'ORCH' },
  ];
  const c = cascadeCtx(sessions);
  await archiveHandler.handler({ type: 'archive', sessionId: 'ORCH', cascade: true }, c);
  assert.deepEqual(c.calls.reply, [{ type: 'archived', sessionId: 'ORCH', unclean: false, archivedChildren: 1, childIds: ['C1'] }]);
});

test('archive: cascade absent/false behaves byte-for-byte like today (single target, no descendant reads)', async () => {
  const c = ctx({ cwd: '/repo', intent: 'do work', label: 'My session' });
  await archiveHandler.handler({ type: 'archive', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.kill, ['S1']);
  assert.equal(c.calls.archive.length, 1);
  assert.equal(c.calls.reply.length, 0); // no killJobsFirst → no reply, exactly like the pre-cascade handler
  // ctx() has no .graph — proving the non-cascade path never touches it.
});

// A ctx for the stop-container handler: entryFor/activeEntries drive the guard,
// and an injected stopContainer records calls without shelling out to real docker.
function stopCtx({ entry, active = [], stopReturns = 'cid1' } = {}) {
  const calls = { stop: [], reply: [] };
  return {
    calls,
    sessionManager: {
      entryFor: () => entry ?? null,
      activeEntries: () => active,
    },
    stopContainer: async (cwd, opts) => { calls.stop.push([cwd, opts]); return stopReturns; },
    reply: (obj) => calls.reply.push(obj),
  };
}

test('containerStillInUse: true when another (non-ignored) devcontainer session shares the exact cwd', () => {
  const sessions = [{ sessionId: 'A', runtime: 'devcontainer', cwd: '/repo' }, { sessionId: 'B', runtime: 'devcontainer', cwd: '/repo' }];
  assert.equal(containerStillInUse('/repo', sessions, ['A']), true);
});

test('containerStillInUse: false once every devcontainer session at that cwd is ignored (a completed archive)', () => {
  const sessions = [{ sessionId: 'A', runtime: 'devcontainer', cwd: '/repo' }, { sessionId: 'B', runtime: 'devcontainer', cwd: '/repo' }];
  assert.equal(containerStillInUse('/repo', sessions, ['A', 'B']), false);
});

test('containerStillInUse: a HOST session at the same cwd does not count (it uses no container)', () => {
  const sessions = [{ sessionId: 'A', runtime: 'devcontainer', cwd: '/repo' }, { sessionId: 'H', runtime: null, cwd: '/repo' }];
  assert.equal(containerStillInUse('/repo', sessions, ['A']), false);
});

test('containerStillInUse: a devcontainer session at a DIFFERENT cwd does not count', () => {
  const sessions = [{ sessionId: 'B', runtime: 'devcontainer', cwd: '/other' }];
  assert.equal(containerStillInUse('/repo', sessions, []), false);
});

test('stop-container: stops the container and replies stopped when no other session shares the cwd', async () => {
  const c = stopCtx({ entry: { runtime: 'devcontainer', cwd: '/repo' }, active: [] });
  await stopContainerHandler.handler({ type: 'stop-container', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.stop.map((s) => s[0]), ['/repo']);
  assert.deepEqual(c.calls.reply, [{ type: 'container-stopped', sessionId: 'S1', stopped: true }]);
});

test('stop-container: reports stopped:false when there was no running container (stopContainer → null)', async () => {
  const c = stopCtx({ entry: { runtime: 'devcontainer', cwd: '/repo' }, active: [], stopReturns: null });
  await stopContainerHandler.handler({ type: 'stop-container', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.reply, [{ type: 'container-stopped', sessionId: 'S1', stopped: false }]);
});

test('stop-container: WITHHELD (never stops) while another active devcontainer session shares the cwd', async () => {
  const c = stopCtx({
    entry: { runtime: 'devcontainer', cwd: '/repo' },
    active: [{ sessionId: 'S2', runtime: 'devcontainer', cwd: '/repo' }],
  });
  await stopContainerHandler.handler({ type: 'stop-container', sessionId: 'S1' }, c);
  assert.equal(c.calls.stop.length, 0, 'the shared container must not be stopped');
  assert.equal(c.calls.reply.length, 1);
  assert.equal(c.calls.reply[0].type, 'error');
  assert.match(c.calls.reply[0].message, /still using this container/);
});

test('stop-container: the session\'s OWN still-mapped active entry never blocks its own stop (ignored)', async () => {
  // Belt-and-suspenders: even if activeEntries still lists the just-archived target
  // (a timing edge), the msg.sessionId is in ignoreIds, so its own entry can't veto.
  const c = stopCtx({
    entry: { runtime: 'devcontainer', cwd: '/repo' },
    active: [{ sessionId: 'S1', runtime: 'devcontainer', cwd: '/repo' }],
  });
  await stopContainerHandler.handler({ type: 'stop-container', sessionId: 'S1' }, c);
  assert.deepEqual(c.calls.reply, [{ type: 'container-stopped', sessionId: 'S1', stopped: true }]);
});

test('stop-container: rejects a non-devcontainer (host) session with a clear error, no stop', async () => {
  const c = stopCtx({ entry: { runtime: undefined, cwd: '/repo' } });
  await stopContainerHandler.handler({ type: 'stop-container', sessionId: 'S1' }, c);
  assert.equal(c.calls.stop.length, 0);
  assert.equal(c.calls.reply[0].type, 'error');
  assert.match(c.calls.reply[0].message, /no devcontainer/);
});

test('stop-container: rejects an unknown/unmapped session (no entry) without shelling out', async () => {
  const c = stopCtx({ entry: null });
  await stopContainerHandler.handler({ type: 'stop-container', sessionId: 'GONE' }, c);
  assert.equal(c.calls.stop.length, 0);
  assert.equal(c.calls.reply[0].type, 'error');
});

test('waitForBackgroundShellClear: gives up and returns false once the deadline passes', async () => {
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const cleared = await waitForBackgroundShellClear('cc_x', '', {
      timeoutMs: 5,
      pollMs: 10, // each sleep jumps past the deadline
      capturePaneFn: async () => 'pane text',
      detectFn: () => true, // never clears
      sleep: async (ms) => { now += ms; },
    });
    assert.equal(cleared, false);
  } finally {
    Date.now = realNow;
  }
});
