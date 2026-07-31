import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSessionTool } from './spawn-session.js';

// A deps double that records what the handler drove and fakes a dispatch that
// mints a fresh card id (and runs the memory binder the way the real one does).
function deps(overrides = {}) {
  const calls = { assign: [], bind: [], dispatch: [], rebuild: 0 };
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
    memoryStore: { bindSession: (sid, taskId) => calls.bind.push({ sid, taskId }) },
    dispatch: async (opts) => {
      calls.dispatch.push(opts);
      opts.bindMemory?.('NEWCARD');
      return { sessionId: 'NEWCARD', cwd: opts.cwd || '/scratch/new', tmux: 'cc_dead' };
    },
    rebuild: async () => { calls.rebuild += 1; },
    ...overrides.deps,
  };
}

test('spawn_session joins the caller’s current task by default', async () => {
  const d = deps();
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'do a thing' });

  assert.equal(d.calls.dispatch.length, 1);
  assert.equal(d.calls.dispatch[0].intent, 'do a thing');
  assert.equal(d.calls.dispatch[0].agent, 'claude');
  // Memory bound to the resolved task BEFORE launch, then the new card assigned.
  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.equal(d.calls.rebuild, 1);
  assert.equal(out.structuredContent.sessionId, 'NEWCARD');
  assert.deepEqual(out.structuredContent.task, { id: 'T1', name: 'Login' });
  assert.equal(out.content[0].type, 'text');
});

test('spawn_session lets `into` override the caller’s task', async () => {
  const d = deps({ tasks: [{ id: 'T1', name: 'Login' }, { id: 'T2', name: 'Billing' }] });
  const out = await spawnSessionTool.handler({ deps: d, caller: 'CARD1' }, { intent: 'x', into: 'T2' });

  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: 'T2' }]);
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T2' }]);
  assert.deepEqual(out.structuredContent.task, { id: 'T2', name: 'Billing' });
});

test('spawn_session falls back to Ad-hoc for a null caller with no `into`', async () => {
  const d = deps({ assignments: {} });
  const out = await spawnSessionTool.handler({ deps: d, caller: null }, { intent: 'x' });

  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: null }]);
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
