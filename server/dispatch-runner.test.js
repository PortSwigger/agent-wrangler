import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDispatch } from './dispatch-runner.js';

// Deps double recording the launch path (mirrors dispatch.test.js). The fake
// dispatch mints a fresh card id and records the options it was given, so we can
// assert the chosen task rides dispatch (the launch context reads it pre-launch)
// BEFORE the card is assigned (the load-bearing ordering).
function deps(overrides = {}) {
  const calls = { dispatch: [], assign: [] };
  return {
    calls,
    sessionManager: {
      entryFor: (id) => overrides.entries?.[id] ?? null,
      dispatch: async (opts) => {
        calls.dispatch.push(opts);
        return { sessionId: 'NEWCARD' };
      },
    },
    taskStore: { assign: (sid, taskId) => calls.assign.push({ sid, taskId }) },
    ...overrides,
  };
}

test('plain dispatch: passes intent and the task through, assigns the task', async () => {
  const d = deps();
  const { sessionId } = await runDispatch({ cwd: '/repo', intent: 'do it', taskId: 'T1' }, d);
  assert.equal(sessionId, 'NEWCARD');
  assert.equal(d.calls.dispatch[0].agent, 'claude');
  assert.equal(d.calls.dispatch[0].intent, 'do it');
  assert.equal(d.calls.dispatch[0].workflow, undefined);
  assert.equal(d.calls.dispatch[0].taskId, 'T1');
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T1' }]);
});

test('no taskId: passes none and skips assign', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x' }, d);
  assert.equal(d.calls.dispatch[0].taskId, undefined);
  assert.deepEqual(d.calls.assign, []);
});

test('workflow: wraps the issue, forces an auto worktree, builds the marker', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'ENT-1234', workflow: true }, d, 123456);
  const opts = d.calls.dispatch[0];
  assert.match(opts.intent, /issue-to-pr skill/);
  assert.match(opts.intent, /Issue: ENT-1234/);
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeAuto, true);
  assert.match(opts.worktreeBranch, /ent-1234/); // seeded from the raw issue, not the wrapper
  assert.ok(opts.workflow);
  assert.equal(opts.workflow.issue, 'ENT-1234');
  assert.equal(opts.workflow.phase.label, 'starting');
  assert.equal(opts.workflow.phase.kind, 'active');
  assert.equal(opts.workflow.phase.at, 123456); // `now` threaded into the marker
});

test('manual worktree options pass through unchanged when not a workflow', async () => {
  const d = deps();
  await runDispatch({
    cwd: '/repo', intent: 'x', worktree: true, worktreeBranch: 'feat', worktreeFolderName: '/wt', worktreeAuto: false,
  }, d);
  const opts = d.calls.dispatch[0];
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeBranch, 'feat');
  assert.equal(opts.worktreeFolderName, '/wt');
  assert.equal(opts.worktreeAuto, false);
});

test('parentSession passes through when given, and is undefined when absent', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x', parentSession: 'SRC1' }, d);
  assert.equal(d.calls.dispatch[0].parentSession, 'SRC1');

  const d2 = deps();
  await runDispatch({ cwd: '/repo', intent: 'x' }, d2);
  assert.equal(d2.calls.dispatch[0].parentSession, undefined);
});

// Nesting only ever renders one level deep (see attachError's file comment in
// server/control/handlers/attach.js) — this guard keeps that true regardless
// of which path sets a brand-new parentSession (peer-review dispatch,
// spawn_session nest:true, a scheduled dispatch), not just Attach.
test('parentSession pointing at an already-nested session is refused before launch', async () => {
  const d = deps({ entries: { SRC1: { parentSession: 'ROOT' } } });
  await assert.rejects(
    () => runDispatch({ cwd: '/repo', intent: 'x', parentSession: 'SRC1' }, d),
    /itself nested/,
  );
  assert.equal(d.calls.dispatch.length, 0);
});

test('parentSession pointing at a top-level session is allowed', async () => {
  const d = deps({ entries: { SRC1: {} } });
  await runDispatch({ cwd: '/repo', intent: 'x', parentSession: 'SRC1' }, d);
  assert.equal(d.calls.dispatch[0].parentSession, 'SRC1');
});

test('addDirs defaults to [] when absent', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x' }, d);
  assert.deepEqual(d.calls.dispatch[0].addDirs, []);
});

test('effort passes through to sessionManager.dispatch', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x', effort: 'high' }, d);
  assert.equal(d.calls.dispatch[0].effort, 'high');
});

test('auto-compaction threshold passes through to sessionManager.dispatch', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x', autoCompactTokens: 200000 }, d);
  assert.equal(d.calls.dispatch[0].autoCompactTokens, 200000);
});

test('a launch failure propagates (callers own the error envelope)', async () => {
  const d = deps({ sessionManager: { dispatch: async () => { throw new Error('Branch feat already exists'); } } });
  await assert.rejects(() => runDispatch({ intent: 'x', worktree: true }, d), /Branch feat already exists/);
});

// Both of runDispatch's callers have an error channel — the /ws dispatch handler
// turns a throw into {type:'error'}, and fireSchedule into a `schedule-error`
// broadcast — so a schedule stored while a model existed fails visibly once that
// model is retired, rather than launching on the ambient default.
test('runDispatch refuses a model the chosen agent does not offer', async () => {
  const d = deps();
  await assert.rejects(
    () => runDispatch({ intent: 'go', agent: 'codex', model: 'opus' }, d),
    /Unknown model "opus" for agent "codex"/,
  );
  assert.equal(d.calls.dispatch.length, 0);
});

test('runDispatch refuses an unknown agent rather than silently launching claude', async () => {
  const d = deps();
  await assert.rejects(() => runDispatch({ intent: 'go', agent: 'codx' }, d), /Unknown agent "codx"/);
  assert.equal(d.calls.dispatch.length, 0);
});

// The spawn path dispatches through sessionManager.dispatch directly and never
// reaches here, which is what keeps a caller-INHERITED legacy model working.
test('runDispatch accepts a valid pair', async () => {
  const d = deps();
  await runDispatch({ intent: 'go', agent: 'codex', model: 'gpt-5.6-sol' }, d);
  assert.equal(d.calls.dispatch[0].model, 'gpt-5.6-sol');
});

test('an ext bag passes through to sessionManager.dispatch; a non-object is dropped', async () => {
  const d = deps();
  await runDispatch({ cwd: '/repo', intent: 'x', ext: { a: { usd: 5 } } }, d);
  await runDispatch({ cwd: '/repo', intent: 'x', ext: ['nope'] }, d);
  assert.deepEqual(d.calls.dispatch[0].ext, { a: { usd: 5 } });
  assert.equal(d.calls.dispatch[1].ext, undefined);
});

test('images in the intent: launch defers the intent, claims the staged files, and pastes images then prose', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { STAGED_PASTES_DIR } = await import('./paste-store.js');
  fs.mkdirSync(STAGED_PASTES_DIR, { recursive: true });
  fs.writeFileSync(path.join(STAGED_PASTES_DIR, 'paste-1-aaaa.png'), 'x');
  const delivered = [];
  const d = deps({ deliverFirstPrompt: async (args) => { delivered.push(args); } });
  d.sessionManager.dispatch = async (opts) => { d.calls.dispatch.push(opts); return { sessionId: 'IMGCARD', tmux: 'cc_img' }; };
  const { firstPrompt } = await runDispatch({ cwd: '/repo', intent: 'what is this?', imageNames: ['paste-1-aaaa.png', '../../etc/passwd', 'paste-2-bbbb.png'] }, d);
  await firstPrompt;
  assert.equal(d.calls.dispatch[0].intent, 'what is this?', 'the card still records the intent');
  assert.equal(d.calls.dispatch[0].deferIntent, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].tmux, 'cc_img');
  assert.equal(delivered[0].text, 'what is this?');
  assert.equal(delivered[0].imagePaths.length, 1, 'only the real staged file survives the name gate');
  assert.equal(path.basename(delivered[0].imagePaths[0]), 'paste-1-aaaa.png');
  assert.ok(fs.existsSync(delivered[0].imagePaths[0]), 'moved into the session pastes dir');
  assert.ok(!fs.existsSync(path.join(STAGED_PASTES_DIR, 'paste-1-aaaa.png')), 'and out of staging');
});

test('no images: the intent rides the launch as before and nothing is pasted', async () => {
  const d = deps({ deliverFirstPrompt: async () => assert.fail('nothing to paste') });
  const { firstPrompt } = await runDispatch({ cwd: '/repo', intent: 'x', imageNames: [] }, d);
  assert.equal(firstPrompt, undefined);
  assert.equal(d.calls.dispatch[0].deferIntent, undefined);
});

test('images in the intent need a local launch', async () => {
  const d = deps();
  await assert.rejects(runDispatch({ cwd: '/repo', intent: 'x', runtime: 'devcontainer', imageNames: ['paste-1-aaaa.png'] }, d), /local launch/);
  assert.equal(d.calls.dispatch.length, 0);
});

test('deliverFirstPrompt waits for the composer, pastes each image alone, then sends the prose once', async () => {
  const { deliverFirstPrompt } = await import('./dispatch-runner.js');
  const steps = [];
  await deliverFirstPrompt({ tmux: 'cc_x', socket: 's', agent: 'claude', text: 'hi', imagePaths: ['/p/1.png', '/p/2.png'] }, {
    waitReady: async (t, s, a) => steps.push(['ready', t, s, a]),
    paste: async (t, s, a, paths) => { steps.push(['paste', a, ...paths]); return true; },
    send: async (t, text) => steps.push(['send', text]),
    confirm: async () => true,
    log: (m) => steps.push(['log', m]),
  });
  assert.deepEqual(steps, [['ready', 'cc_x', 's', 'claude'], ['paste', 'claude', '/p/1.png', '/p/2.png'], ['send', 'hi']]);
  const logs = [];
  await deliverFirstPrompt({ tmux: 'cc_y', agent: 'claude', text: 'hi', imagePaths: [] }, { waitReady: async () => { throw new Error('gone'); }, log: (m) => logs.push(m) });
  assert.match(logs[0], /could not deliver/);
});

// The stray `[Image #2]` bug: a 4 MB screenshot took Claude Code ~1.6s to attach,
// so the prose and Enter went first and the marker was left unsent behind them.
test('deliverFirstPrompt sends the prose only after the composer shows the image marker', async () => {
  const { deliverFirstPrompt } = await import('./dispatch-runner.js');
  const { pasteImages } = await import('./pane-ready.js');
  let composer = '❯ ';
  let captures = 0;
  const steps = [];
  await deliverFirstPrompt({ tmux: 'cc_x', agent: 'claude', text: 'hi', imagePaths: ['/p/big.png'] }, {
    waitReady: async () => true,
    paste: (t, s, a, paths) => pasteImages(t, s, a, paths, {
      prefill: async (n, p) => { steps.push(['prefill', p]); composer = '❯ \n  Pasting…'; },
      // The marker turns up a few polls after the paste, as it does live.
      capture: async () => { captures += 1; if (captures === 5) composer = '❯ [Image #1]'; return composer; },
      sleep: async () => steps.push(['wait']),
    }),
    send: async (t, text) => steps.push(['send', text, composer]),
    confirm: async () => true,
    log: (m) => steps.push(['log', m]),
  });
  assert.deepEqual(steps.at(-1), ['send', 'hi', '❯ [Image #1]'], 'the prose is sent after the marker, not before');
  assert.equal(steps.filter(([k]) => k === 'prefill').length, 1, 'the image is pasted exactly once');
  assert.ok(steps.some(([k]) => k === 'wait'), 'and it waited for the attach');
  assert.ok(!steps.some(([k]) => k === 'log'));
});
