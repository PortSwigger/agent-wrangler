import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTasksTool } from './list-tasks.js';

const SCRATCH = '/Users/x/.agent-wrangler/sessions';

// deps mirror the real shapes: taskStore.snapshot() exposes the task list,
// taskStore.taskFor(sessionId) resolves a session's assigned task, the graph
// supplies the session objects (cwd + lastActivity), and sessionsDir is the
// scratch root that bestFolder folds out — exactly what the board UI reads.
function deps({ tasks = [], sessions = [], assignments = {}, sessionsDir = SCRATCH } = {}) {
  return {
    sessionsDir,
    graph: () => ({ sessions }),
    taskStore: {
      snapshot: () => ({ tasks }),
      taskFor: (sid) => {
        const t = tasks.find((x) => x.id === assignments[sid]);
        return t ? { id: t.id, name: t.name } : null;
      },
    },
  };
}

test('list_tasks resolves bestFolder to the shared repo when all sessions sit in one base', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [{ id: 'T1', name: 'Agent Wrangler' }],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/agent-wrangler' },
        { sessionId: 'C2', cwd: '/Users/x/vcs/agent-wrangler' },
      ],
      assignments: { C1: 'T1', C2: 'T1' },
    }),
    caller: null,
  });
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  assert.equal(t1.name, 'Agent Wrangler');
  assert.equal(t1.bestFolder, '/Users/x/vcs/agent-wrangler');
  assert.equal(t1.sessionCount, 2);
  assert.equal(out.content[0].type, 'text');
});

test('list_tasks collapses wrangler `-worktree-` cwds back to the base repo', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [{ id: 'T1', name: 'Agent Wrangler' }],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/agent-wrangler' },
        { sessionId: 'C2', cwd: '/Users/x/vcs/agent-wrangler-worktree-fix-xyz' },
        { sessionId: 'C3', cwd: '/Users/x/vcs/agent-wrangler-worktree-feature-2' },
      ],
      assignments: { C1: 'T1', C2: 'T1', C3: 'T1' },
    }),
    caller: null,
  });
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  assert.equal(t1.bestFolder, '/Users/x/vcs/agent-wrangler');
  assert.equal(t1.sessionCount, 3);
});

test('list_tasks collapses `.claude/worktrees/` cwds back to the base repo', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [{ id: 'T1', name: 'Acme AI data pipeline' }],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/acme-pipeline' },
        { sessionId: 'C2', cwd: '/Users/x/vcs/acme-pipeline/.claude/worktrees/salt-raw' },
      ],
      assignments: { C1: 'T1', C2: 'T1' },
    }),
    caller: null,
  });
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  assert.equal(t1.bestFolder, '/Users/x/vcs/acme-pipeline');
  assert.equal(t1.sessionCount, 2);
});

test('list_tasks resolves a base repo even when every session is a worktree', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [{ id: 'T1', name: 'Acme AI data pipeline' }],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/acme-pipeline-worktree-a' },
        { sessionId: 'C2', cwd: '/Users/x/vcs/acme-pipeline-worktree-b' },
      ],
      assignments: { C1: 'T1', C2: 'T1' },
    }),
    caller: null,
  });
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  assert.equal(t1.bestFolder, '/Users/x/vcs/acme-pipeline');
});

test('list_tasks returns bestFolder null for a task with no sessions', async () => {
  const out = await listTasksTool.handler({
    deps: deps({ tasks: [{ id: 'T9', name: 'Empty' }] }),
    caller: null,
  });
  const t9 = out.structuredContent.tasks.find((t) => t.id === 'T9');
  assert.equal(t9.bestFolder, null);
  assert.equal(t9.sessionCount, 0);
});

test('list_tasks ignores scratch cwds when picking bestFolder but still counts the session', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [{ id: 'T1', name: 'Agent Wrangler' }],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/agent-wrangler' },
        { sessionId: 'C2', cwd: `${SCRATCH}/abc123` },
      ],
      assignments: { C1: 'T1', C2: 'T1' },
    }),
    caller: null,
  });
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  assert.equal(t1.bestFolder, '/Users/x/vcs/agent-wrangler');
  assert.equal(t1.sessionCount, 2);
});

test('list_tasks breaks a folder tie toward the most recently active session', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [{ id: 'T1', name: 'Mixed' }],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/repoA', lastActivity: 100 },
        { sessionId: 'C2', cwd: '/Users/x/vcs/repoB', lastActivity: 999 },
      ],
      assignments: { C1: 'T1', C2: 'T1' },
    }),
    caller: null,
  });
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  assert.equal(t1.bestFolder, '/Users/x/vcs/repoB');
});

test('list_tasks lists every task and keeps their folders distinct', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [
        { id: 'T1', name: 'Agent Wrangler' },
        { id: 'T2', name: 'Acme AI data pipeline' },
      ],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/agent-wrangler-worktree-foo' },
        { sessionId: 'C2', cwd: '/Users/x/vcs/acme-pipeline' },
      ],
      assignments: { C1: 'T1', C2: 'T2' },
    }),
    caller: null,
  });
  assert.equal(out.structuredContent.tasks.length, 2);
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  const t2 = out.structuredContent.tasks.find((t) => t.id === 'T2');
  assert.equal(t1.bestFolder, '/Users/x/vcs/agent-wrangler');
  assert.equal(t2.bestFolder, '/Users/x/vcs/acme-pipeline');
});

test('list_tasks ignores unassigned (adhoc) sessions — they belong to no task', async () => {
  const out = await listTasksTool.handler({
    deps: deps({
      tasks: [{ id: 'T1', name: 'Agent Wrangler' }],
      sessions: [
        { sessionId: 'C1', cwd: '/Users/x/vcs/agent-wrangler' },
        { sessionId: 'C2', cwd: '/Users/x/vcs/something-else' }, // unassigned → no taskFor
      ],
      assignments: { C1: 'T1' },
    }),
    caller: null,
  });
  const t1 = out.structuredContent.tasks.find((t) => t.id === 'T1');
  assert.equal(t1.sessionCount, 1);
  assert.equal(t1.bestFolder, '/Users/x/vcs/agent-wrangler');
});
