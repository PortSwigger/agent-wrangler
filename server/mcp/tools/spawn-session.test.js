import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSessionTool } from './spawn-session.js';
import { registerRuntime, unregisterRuntimesFor } from '../../runtimes/index.js';

// A deps double that records what the handler drove and fakes a dispatch that
// mints a fresh card id (and records the options it was given, as the real one would see them).
function deps(overrides = {}) {
  const calls = { assign: [], dispatch: [], rebuild: 0 };
  const tasks = overrides.tasks ?? [{ id: 'T1', name: 'Login' }];
  const assignments = overrides.assignments ?? { CARD1: 'T1' };
  const entries = overrides.entries ?? { CARD1: { agent: 'claude', model: 'sonnet' } };
  return {
    calls,
    sessionManager: { entryFor: (sid) => entries[sid] },
    taskStore: {
      taskFor: (sid) => {
        const id = assignments[sid];
        const t = id && tasks.find((x) => x.id === id);
        return t ? { id: t.id, name: t.name } : null;
      },
      assign: (sid, taskId) => {
        calls.assign.push({ sid, taskId });
        if (tasks.some((t) => t.id === taskId)) { assignments[sid] = taskId; return true; }
        return false;
      },
    },
    dispatch: async (opts) => {
      calls.dispatch.push(opts);
      return { sessionId: 'NEWCARD', cwd: opts.cwd || '/scratch/new', tmux: 'cc_dead' };
    },
    rebuild: async () => { calls.rebuild += 1; },
    ...overrides.deps,
  };
}

test('spawn_session passes a registered extension runtime through to dispatch', async () => {
  registerRuntime({ id: 'toyrt', label: 'Toy', wrapLaunch: async ({ inner }) => inner }, 'toy');
  try {
    const d = deps();
    const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', runtime: 'toyrt' });
    assert.equal(out.isError, undefined);
    assert.equal(d.calls.dispatch[0].runtime, 'toyrt');
  } finally {
    unregisterRuntimesFor('toy');
  }
});

test('spawn_session refuses an unknown runtime, listing the known ones, without dispatching', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', runtime: 'toyrt' });
  assert.equal(out.isError, true);
  assert.equal(out.content[0].text, 'Unknown runtime "toyrt". Known runtimes: local, devcontainer.');
  assert.equal(d.calls.dispatch.length, 0);
});

test('spawn_session\'s runtime description names the runtimes registered when it is read', () => {
  const describe = () => spawnSessionTool.inputSchema.runtime.description;
  assert.equal(describe(), 'Where the new session runs. Valid values — `local` (default), `devcontainer`.');
  registerRuntime({ id: 'toyrt', label: 'Toy', wrapLaunch: async ({ inner }) => inner }, 'toy');
  try {
    assert.equal(describe(), 'Where the new session runs. Valid values — `local` (default), `devcontainer`, `toyrt` (extension).');
  } finally {
    unregisterRuntimesFor('toy');
  }
  assert.equal(describe(), 'Where the new session runs. Valid values — `local` (default), `devcontainer`.');
});

test('spawn_session with no runtime stays local (dispatch default)', async () => {
  const d = deps();
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });
  assert.equal(d.calls.dispatch[0].runtime, undefined);
});

test('spawn_session joins the caller’s current task by default', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'do a thing' });

  assert.equal(d.calls.dispatch.length, 1);
  assert.equal(d.calls.dispatch[0].intent, 'do a thing');
  assert.equal(d.calls.dispatch[0].agent, 'claude');
  assert.equal(d.calls.dispatch[0].taskId, 'T1'); // the task rides dispatch so the launch context sees it BEFORE launch
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.equal(d.calls.rebuild, 1);
  assert.equal(out.structuredContent.sessionId, 'NEWCARD');
  assert.deepEqual(out.structuredContent.task, { id: 'T1', name: 'Login' });
  assert.equal(out.content[0].type, 'text');
});

// The caller has no way to refer to the new session by name (only spawn's own
// return value ever names it) unless this comes back — without it, the only
// identifier a caller can report to a human is the raw card id.
test('spawn_session returns the new session’s label so the caller can refer to it by name', async () => {
  const d = deps({
    deps: { graph: () => ({ sessions: [{ sessionId: 'NEWCARD', label: 'Fresh Worker' }] }) },
  });
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'do a thing' });

  assert.equal(out.structuredContent.label, 'Fresh Worker');
});

test('spawn_session reports a null label when the graph has no row for the new session yet', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'do a thing' });

  assert.equal(out.structuredContent.label, null);
});

test('spawn_session lets `into` override the caller’s task', async () => {
  const d = deps({ tasks: [{ id: 'T1', name: 'Login' }, { id: 'T2', name: 'Billing' }] });
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', into: 'T2' });

  assert.equal(d.calls.dispatch[0].taskId, 'T2'); // the task rides dispatch so the launch context sees it BEFORE launch
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T2' }]);
  assert.deepEqual(out.structuredContent.task, { id: 'T2', name: 'Billing' });
});

test('spawn_session falls back to Ad-hoc for a null caller with no `into`', async () => {
  const d = deps({ assignments: {} });
  const out = await spawnSessionTool.handler({ deps: d, caller: null }, { intent: 'x' });

  assert.equal(d.calls.dispatch[0].taskId, undefined); // no task: the launch context sees none
  assert.deepEqual(d.calls.assign, []); // no task → no assignment
  assert.equal(out.structuredContent.task, null);
});

test('spawn_session passes agent, model, cwd and worktree options through to dispatch', async () => {
  const d = deps();
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, {
    intent: 'x', agent: 'codex', model: 'gpt-5.5', cwd: '/repo',
    worktree: true, worktree_branch: 'feat', worktree_folder_name: 'wt', worktree_auto: true,
  });
  const opts = d.calls.dispatch[0];
  assert.equal(opts.agent, 'codex');
  assert.equal(opts.model, 'gpt-5.5');
  assert.equal(opts.cwd, '/repo');
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeBranch, 'feat');
  assert.equal(opts.worktreeFolderName, 'wt');
  assert.equal(opts.worktreeAuto, true);
});

test('spawn_session passes auto_compact_tokens through as the session threshold', async () => {
  const d = deps();
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', auto_compact_tokens: 200000 });
  assert.equal(d.calls.dispatch[0].autoCompactTokens, 200000);
});

test('spawn_session accepts Codex’s 50k auto-compaction threshold', async () => {
  const d = deps();
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', agent: 'codex', auto_compact_tokens: 50000 });
  assert.equal(d.calls.dispatch[0].autoCompactTokens, 50000);
});

test('spawn_session rejects an out-of-range auto_compact_tokens value before dispatch', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', auto_compact_tokens: 99999 });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /100000/);
  assert.equal(d.calls.dispatch.length, 0);
});

test('spawn_session defaults the model to the caller’s model', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet' } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });
  assert.equal(d.calls.dispatch[0].model, 'sonnet');
});

test('spawn_session lets an explicit model override the caller’s model', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet' } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', model: 'haiku' });
  assert.equal(d.calls.dispatch[0].model, 'haiku');
});

test('spawn_session does not inherit a model across agents', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet' } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', agent: 'codex' });
  assert.equal(d.calls.dispatch[0].model, undefined);
});

test('spawn_session passes an explicit effort through to dispatch', async () => {
  const d = deps();
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', effort: 'high' });
  assert.equal(d.calls.dispatch[0].effort, 'high');
});

test('spawn_session defaults the effort to the caller’s effort', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet', effort: 'xhigh' } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });
  assert.equal(d.calls.dispatch[0].effort, 'xhigh');
});

// Effort levels don't cross agents any more than model names do — codex has
// `ultra`, claude does not — so an inherited one may not be valid over there.
test('spawn_session does not inherit an effort across agents', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet', effort: 'xhigh' } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', agent: 'codex' });
  assert.equal(d.calls.dispatch[0].effort, undefined);
});

test('spawn_session refuses an effort the chosen agent does not offer', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler(
    { deps: d, caller: 'CARD1' }, { intent: 'x', agent: 'claude', effort: 'ultra' });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown effort "ultra" for agent "claude"/);
  assert.equal(d.calls.dispatch.length, 0);
});

test('spawn_session leaves model unset when the caller is on the agent default', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: null } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });
  assert.equal(d.calls.dispatch[0].model, undefined);
});

test('spawn_session leaves parentSession unset by default, even when the caller is a workflow orchestrator', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet', workflow: { issue: 'ENT-1', phase: { label: 'implementing' } } } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });
  assert.equal(d.calls.dispatch[0].parentSession, undefined);
  assert.equal(d.calls.dispatch[0].workflow, undefined);
});

test('spawn_session tags parentSession = caller only when nest: true is explicitly passed', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet', workflow: { issue: 'ENT-1', phase: { label: 'implementing' } } } } });
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', nest: true });
  assert.equal(d.calls.dispatch[0].parentSession, 'CARD1');
  assert.equal(d.calls.dispatch[0].workflow, undefined); // never sets workflow — orchestrator-only
});

// Nesting only ever renders one level deep — CARD1 is already nested under
// ORCH here, so nesting a new spawn under CARD1 would land it at depth 2,
// which the board can't draw. Refused before dispatch, not silently chained.
test('spawn_session refuses nest:true when the caller is itself already nested (would create depth 2)', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet', parentSession: 'ORCH' } } });
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', nest: true });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /itself nested/);
  assert.equal(d.calls.dispatch.length, 0);
  assert.equal(d.calls.rebuild, 0);
});

test('spawn_session sets no parentSession for a null caller, even with nest: true (nothing to nest under)', async () => {
  const d = deps({ assignments: {} });
  await spawnSessionTool.handler({ deps: d, caller: null }, { intent: 'x', nest: true });
  assert.equal(d.calls.dispatch[0].parentSession, undefined);
});

test('spawn_session expands and validates add_dirs before launching', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-spawn-'));
  const d = deps();
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', add_dirs: ['~', tmp] });
  const expanded = d.calls.dispatch[0].addDirs;
  assert.deepEqual(expanded, [os.homedir(), tmp]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('spawn_session rejects a non-existent add_dir without launching', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' },
    { intent: 'x', add_dirs: ['/no/such/dir/anywhere'] });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /\/no\/such\/dir\/anywhere/);
  assert.equal(d.calls.dispatch.length, 0); // aborted before dispatch
});

test('spawn_session passes spawnedBy (caller card id) to dispatch', async () => {
  const d = deps();
  await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });
  assert.equal(d.calls.dispatch[0].spawnedBy, 'CARD1');
});

test('spawn_session passes spawnedBy as undefined when caller is null', async () => {
  const d = deps({ assignments: {} });
  await spawnSessionTool.handler({ deps: d, caller: null }, { intent: 'x' });
  assert.equal(d.calls.dispatch[0].spawnedBy, undefined);
});

test('spawn_session surfaces a dispatch failure as an error result', async () => {
  const d = deps({ deps: { dispatch: async () => { throw new Error('Branch feat already exists'); } } });
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', worktree: true });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Branch feat already exists/);
});

// The tool takes `model`/`agent` as free strings from an agent, not from a UI
// dropdown, so a typo'd or stale name would otherwise reach the CLI unchecked.
test('spawn_session refuses a model the chosen agent does not offer', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler(
    { deps: d, caller: 'CARD1' }, { intent: 'x', agent: 'codex', model: 'opus' });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown model "opus" for agent "codex"/);
  // Names the way out, since a cross-agent spawn is where this goes wrong.
  assert.match(out.content[0].text, /is a claude model/);
  assert.equal(d.calls.dispatch.length, 0);
});

// adapterFor silently resolves an unknown id to claude, so without this the
// session launches on the wrong agent entirely and nothing says so.
test('spawn_session refuses an unknown agent, ahead of the model', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler(
    { deps: d, caller: 'CARD1' }, { intent: 'x', agent: 'codx', model: 'gpt-5.6-sol' });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /Unknown agent "codx"/);
  assert.equal(d.calls.dispatch.length, 0);
});

// Validation covers the CALLER-SUPPLIED model only. An entry may carry a value
// since dropped from an adapter; failing the spawn over a string the caller
// never passed would break the inheritance this tool exists to provide.
test('spawn_session still inherits a caller model the adapter no longer offers', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'opus-legacy' } } });
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });

  assert.equal(out.isError, undefined);
  assert.equal(d.calls.dispatch[0].model, 'opus-legacy');
});

// A cloud-like runtime whose launch outcome arrives after dispatch returns.
function withLaunchRuntime(launchStatus, fn) {
  registerRuntime({ id: 'toyrt', label: 'Toy', wrapLaunch: async ({ inner }) => inner, launchStatus }, 'toy');
  return fn().finally(() => unregisterRuntimesFor('toy'));
}
const launchDeps = () => deps({
  entries: { CARD1: { agent: 'claude', model: 'sonnet' }, NEWCARD: { runtime: 'toyrt' } },
  deps: { launchWait: { sleep: async () => {} } },
});

test('spawn_session returns a failed launch as an error that keeps the new session id', () => withLaunchRuntime(
  () => ({ state: 'failed', error: 'no GitHub remote was detected' }),
  async () => {
    const out = await spawnSessionTool.handler({ deps: launchDeps(), caller: 'CARD1' }, { intent: 'x', runtime: 'toyrt' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /^The session was created but its launch failed: no GitHub remote was detected/);
    assert.equal(out.structuredContent.sessionId, 'NEWCARD');
    assert.deepEqual(out.structuredContent.launch, { state: 'failed', error: 'no GitHub remote was detected' });
  },
));

test('spawn_session waits for a pending launch and reports the outcome', () => {
  let calls = 0;
  return withLaunchRuntime(
    () => (++calls < 3 ? { state: 'pending' } : { state: 'ok', url: 'https://claude.ai/code/session_1' }),
    async () => {
      const out = await spawnSessionTool.handler({ deps: launchDeps(), caller: 'CARD1' }, { intent: 'x', runtime: 'toyrt' });
      assert.equal(out.isError, undefined);
      assert.deepEqual(out.structuredContent.launch, { state: 'ok', url: 'https://claude.ai/code/session_1' });
      assert.equal(calls, 3);
    },
  );
});

test('spawn_session with wait: false does not ask the runtime', () => {
  let asked = false;
  return withLaunchRuntime(
    () => { asked = true; return { state: 'failed', error: 'x' }; },
    async () => {
      const out = await spawnSessionTool.handler({ deps: launchDeps(), caller: 'CARD1' }, { intent: 'x', runtime: 'toyrt', wait: false });
      assert.equal(out.isError, undefined);
      assert.equal(out.structuredContent.launch, undefined);
      assert.equal(asked, false);
    },
  );
});

test('spawn_session on a runtime without launchStatus has no launch field', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude' }, NEWCARD: {} } });
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x' });
  assert.equal(out.structuredContent.launch, undefined);
});
