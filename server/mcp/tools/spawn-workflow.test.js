import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnWorkflowTool } from './spawn-workflow.js';

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

test('spawn_workflow wraps the raw issue into the issue-to-pr launch prompt', async () => {
  const d = deps();
  await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-42' });

  const opts = d.calls.dispatch[0];
  assert.match(opts.intent, /issue-to-pr skill/);
  assert.match(opts.intent, /ENT-42/);
});

test('spawn_workflow forces a fresh auto worktree on, branched off the raw issue', async () => {
  const d = deps();
  await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'fix the login bug' });

  const opts = d.calls.dispatch[0];
  assert.equal(opts.worktree, true);
  assert.equal(opts.worktreeAuto, true);
  // Branch slugged from the RAW issue, not the wrapped "use issue-to-pr skill" prompt.
  assert.equal(opts.worktreeBranch, 'fix-login-bug');
  assert.equal(opts.worktreeFolderName, '');
});

test('spawn_workflow stamps a fresh orchestrator marker', async () => {
  const d = deps();
  await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-42' });

  const { workflow } = d.calls.dispatch[0];
  assert.equal(workflow.issue, 'ENT-42');
  assert.deepEqual(workflow.phase, { label: 'starting', kind: 'active', at: workflow.phase.at });
  assert.equal(typeof workflow.phase.at, 'number');
  assert.equal(typeof workflow.startedAt, 'number');
  // No parent — it is a top-level run, not a worker.
  assert.equal(workflow.parent, undefined);
});

test('spawn_workflow stays top-level even when the caller is an orchestrator', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet', workflow: { issue: 'ENT-1', phase: { label: 'implementing' } } } } });
  await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-99' });

  const { workflow } = d.calls.dispatch[0];
  // Unlike spawn_session, a workflow spawned by an orchestrator is NOT tagged as
  // its worker — it mints its own fresh orchestrator marker.
  assert.equal(workflow.parent, undefined);
  assert.equal(workflow.issue, 'ENT-99');
});

test('spawn_workflow joins the caller’s current task by default', async () => {
  const d = deps();
  const out = await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-42' });

  assert.equal(d.calls.dispatch.length, 1);
  // Memory bound to the resolved task BEFORE launch, then the new card assigned.
  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T1' }]);
  assert.equal(d.calls.rebuild, 1);
  assert.equal(out.structuredContent.sessionId, 'NEWCARD');
  assert.deepEqual(out.structuredContent.task, { id: 'T1', name: 'Login' });
});

test('spawn_workflow lets `into` override the caller’s task', async () => {
  const d = deps({ tasks: [{ id: 'T1', name: 'Login' }, { id: 'T2', name: 'Billing' }] });
  const out = await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-42', into: 'T2' });

  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: 'T2' }]);
  assert.deepEqual(d.calls.assign, [{ sid: 'NEWCARD', taskId: 'T2' }]);
  assert.deepEqual(out.structuredContent.task, { id: 'T2', name: 'Billing' });
});

test('spawn_workflow falls back to Ad-hoc for a null caller with no `into`', async () => {
  const d = deps({ assignments: {} });
  const out = await spawnWorkflowTool.handler({ deps: d, caller: null }, { issue: 'ENT-42' });

  assert.deepEqual(d.calls.bind, [{ sid: 'NEWCARD', taskId: null }]);
  assert.deepEqual(d.calls.assign, []); // no task → no assignment
  assert.equal(out.structuredContent.task, null);
});

test('spawn_workflow defaults the model to the caller’s model and lets it be overridden', async () => {
  const inherit = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet' } } });
  await spawnWorkflowTool.handler({ deps: inherit, caller: 'CARD1' }, { issue: 'ENT-42' });
  assert.equal(inherit.calls.dispatch[0].model, 'sonnet');

  const override = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet' } } });
  await spawnWorkflowTool.handler({ deps: override, caller: 'CARD1' }, { issue: 'ENT-42', model: 'opus' });
  assert.equal(override.calls.dispatch[0].model, 'opus');
});

test('spawn_workflow does not inherit a model across agents', async () => {
  const d = deps({ entries: { CARD1: { agent: 'claude', model: 'sonnet' } } });
  await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-42', agent: 'codex' });
  assert.equal(d.calls.dispatch[0].model, undefined);
});

test('spawn_workflow expands and validates add_dirs before launching', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-workflow-'));
  const d = deps();
  await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-42', add_dirs: ['~', tmp] });
  assert.deepEqual(d.calls.dispatch[0].addDirs, [os.homedir(), tmp]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('spawn_workflow rejects a non-existent add_dir without launching', async () => {
  const d = deps();
  const out = await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' },
    { issue: 'ENT-42', add_dirs: ['/no/such/dir/anywhere'] });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /\/no\/such\/dir\/anywhere/);
  assert.equal(d.calls.dispatch.length, 0); // aborted before dispatch
});

test('spawn_workflow errors when issue is missing', async () => {
  const d = deps();
  const out = await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, {});

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /issue is required/);
  assert.equal(d.calls.dispatch.length, 0);
});

test('spawn_workflow surfaces a dispatch failure as an error result', async () => {
  const d = deps({ deps: { dispatch: async () => { throw new Error('worktree create failed'); } } });
  const out = await spawnWorkflowTool.handler({ deps: d, caller: 'CARD1' }, { issue: 'ENT-42' });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /worktree create failed/);
});
