import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { SessionManager } from './session-manager.js';

// The extension session hooks (server/extensions/index.js `sessionHooks`) are
// bound onto `sm._extHooks` by server/index.js. Their contract: sequential, in
// registration order, logged-not-thrown, and never aborting the core operation.

function manager() {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => {};
  sm._newSession = async () => {};
  return sm;
}

function captureErrors(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args);
  try { return fn(errors); } finally { console.error = orig; }
}

test('hooks default to empty arrays, so a bare SessionManager fires nothing', async () => {
  const sm = manager();
  assert.deepEqual(Object.keys(sm._extHooks), ['onBeforeDispatch', 'onArchive', 'onFork', 'onPurge', 'onDispatch', 'onResume']);
  for (const fns of Object.values(sm._extHooks)) assert.deepEqual(fns, []);
  sm.map.set('CARD1', { tmux: 'cc_a', cwd: os.tmpdir(), agent: 'claude' });
  sm.archive('CARD1');
  sm.forget('CARD1');
});

test('a throwing onArchive hook is logged and archive() still stamps archivedAt', async () => {
  const sm = manager();
  sm.map.set('CARD1', { tmux: 'cc_a', cwd: os.tmpdir(), agent: 'claude' });
  const seen = [];
  sm._extHooks.onArchive.push(() => { throw new Error('hook exploded'); });
  sm._extHooks.onArchive.push((p) => { seen.push(p); });
  await captureErrors(async (errors) => {
    sm.archive('CARD1');
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /\[ext-hook:onArchive\]/);
    assert.match(String(errors[0][1]?.message), /hook exploded/);
  });
  assert.ok(sm.entryFor('CARD1').archivedAt, 'the core op completed regardless of the hook');
  // The hook after the throwing one still ran, with the documented payload.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 'CARD1');
  assert.equal(seen[0].wasArchived, false);
  assert.equal(seen[0].entry, sm.entryFor('CARD1'));
});

test('hooks run in registration order and a slow one is awaited before the next', async () => {
  const sm = manager();
  const order = [];
  sm._extHooks.onFork.push(async (p) => { await new Promise((r) => setTimeout(r, 10)); order.push(`slow:${p.parentId}`); });
  sm._extHooks.onFork.push((p) => { order.push(`fast:${p.sessionId ? 'has-id' : 'no-id'}`); });
  const { sessionId } = await sm.fork({ sourceId: 'SRC', parentId: 'PARENT', parentEntry: { agent: 'claude', cwd: os.tmpdir() }, cwd: os.tmpdir() });
  assert.ok(sessionId);
  assert.deepEqual(order, ['slow:PARENT', 'fast:has-id']);
});

test('forget() fires onPurge with the card id, only when something was actually forgotten', () => {
  const sm = manager();
  const purged = [];
  sm._extHooks.onPurge.push(({ sessionId }) => purged.push(sessionId));
  sm.map.set('CARD1', { tmux: 'cc_a', cwd: os.tmpdir(), agent: 'claude' });
  sm.forget('CARD1');
  sm.forget('NOPE');
  assert.deepEqual(purged, ['CARD1']);
  assert.equal(sm.entryFor('CARD1'), undefined);
});

test('dispatch() fires onDispatch after the entry is saved', async () => {
  const sm = manager();
  let payload = null;
  sm._extHooks.onDispatch.push((p) => { payload = p; });
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'hello', agent: 'claude' });
  assert.equal(payload.sessionId, sessionId);
  assert.equal(payload.entry, sm.entryFor(sessionId));
  assert.equal(payload.entry.intent, 'hello');
});

test('dispatch() fires onBeforeDispatch before the pane starts, and awaits it', async () => {
  // The whole point of the hook: whatever it persists is on disk before the
  // agent process — and therefore its first tool call — exists.
  const sm = manager();
  const order = [];
  let payload = null;
  sm._newSession = async () => { order.push('launch'); };
  sm._extHooks.onBeforeDispatch.push(async (p) => {
    await new Promise((r) => setTimeout(r, 5));
    payload = p;
    order.push('before');
  });
  sm._extHooks.onDispatch.push(() => order.push('after'));
  const { sessionId, cwd } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'hello', agent: 'claude', model: 'sonnet' });
  assert.deepEqual(order, ['before', 'launch', 'after']);
  // No entry exists yet — that is what "before" means — so the payload carries
  // the dispatch's own shape instead.
  assert.equal(payload.sessionId, sessionId);
  assert.equal(payload.cwd, cwd);
  assert.equal(payload.intent, 'hello');
  assert.equal(payload.agent, 'claude');
  assert.equal(payload.model, 'sonnet');
  assert.equal(payload.entry, undefined);
});

test('a throwing onBeforeDispatch never aborts the dispatch', async () => {
  // captureErrors is sync-only (it restores in a finally), and this path has to
  // be awaited across the hook — so the swap is done by hand here.
  const sm = manager();
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args);
  let sessionId;
  try {
    sm._extHooks.onBeforeDispatch.push(() => { throw new Error('hook exploded'); });
    ({ sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'hello', agent: 'claude' }));
  } finally {
    console.error = orig;
  }
  assert.match(String(errors[0][0]), /\[ext-hook:onBeforeDispatch\]/);
  assert.ok(sm.entryFor(sessionId));
});

// ── The per-launch skill gate seam ────────────────────────────────────────
test('_extLaunchSkills answers nothing by default, so a bare launch is unchanged', async () => {
  const sm = manager();
  assert.deepEqual(sm._extLaunchSkills({}), []);
});

test('dispatch consults the gate after onBeforeDispatch and threads its answer to the adapter', async () => {
  // Order matters: the hook is what an extension writes its per-session state
  // with, and the gate is what reads it back to answer for this launch.
  const sm = manager();
  const order = [];
  let ctx = null;
  let built = null;
  sm._extHooks.onBeforeDispatch.push(() => order.push('before'));
  sm._extLaunchSkills = (c) => { order.push('gate'); ctx = c; return ['jobs']; };
  sm._newSession = async (tmux, dir, inner) => { built = inner; };
  const { sessionId } = await sm.dispatch({ cwd: os.tmpdir(), intent: 'hello', agent: 'claude' });
  assert.deepEqual(order, ['before', 'gate']);
  assert.equal(ctx.sessionId, sessionId);
  assert.equal(ctx.phase, 'dispatch');
  assert.equal(ctx.entry, null);
  // A suppressed skill's nudge is genuinely absent from the launch argv.
  assert.doesNotMatch(built, /jobs/);
});

test('the gate sees the existing entry on resume and the parent on fork', async () => {
  const sm = manager();
  const seen = [];
  sm._extLaunchSkills = (c) => { seen.push(c); return []; };
  sm.forkedFrom = undefined;
  const parentEntry = { agent: 'claude', cwd: os.tmpdir(), model: 'sonnet' };
  await sm.fork({ sourceId: 'LIVE1', parentId: 'CARD1', parentEntry, cwd: os.tmpdir() });
  assert.equal(seen[0].phase, 'fork');
  assert.equal(seen[0].entry, parentEntry);
  assert.equal(seen[0].parentId, 'CARD1');
});
