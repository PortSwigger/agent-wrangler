import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSession, projectTask, deepFreeze } from './project.js';

function entry() {
  return {
    agent: 'codex',
    cwd: '/tmp/x',
    intent: 'fix it',
    model: 'sonnet',
    liveSessionId: 'real-conversation-uuid',
    priorLiveSessionIds: ['older-uuid'],
    archivedAt: null,
    createdAt: 111,
    parentSession: 'p1',
    spawnedBy: 'p1',
    worktree: { branch: 'b', path: '/wt', repoRoot: '/repo', extra: 'bookkeeping' },
  };
}

test('a session projection never carries a conversation id', () => {
  const p = projectSession(entry(), 'card-1');
  assert.equal('liveSessionId' in p, false);
  assert.equal('priorLiveSessionIds' in p, false);
  assert.equal(p.sessionId, 'card-1');
  assert.equal(p.agent, 'codex');
  assert.equal(p.parentSession, 'p1');
});

test('the worktree is a summary, not the stored object', () => {
  const p = projectSession(entry(), 'card-1');
  assert.deepEqual(Object.keys(p.worktree).sort(), ['branch', 'path', 'repoRoot']);
});

test('a projection is frozen all the way down and mutating it cannot reach the source', () => {
  const src = entry();
  const p = projectSession(src, 'card-1');
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.worktree));
  assert.throws(() => { p.cwd = '/elsewhere'; }, TypeError);
  assert.throws(() => { p.worktree.repoRoot = '/hijack'; }, TypeError);
  assert.equal(src.cwd, '/tmp/x');
  assert.equal(src.worktree.repoRoot, '/repo');
});

test('taskId is passed in, not read off the entry', () => {
  assert.equal(projectSession(entry(), 'c').taskId, null);
  assert.equal(projectSession(entry(), 'c', { taskId: 't_1' }).taskId, 't_1');
});

test('a missing entry projects to a shaped null-ish row rather than throwing', () => {
  const p = projectSession(null, 'c');
  assert.equal(p.sessionId, 'c');
  assert.equal(p.agent, 'claude');
  assert.equal(p.worktree, null);
});

test('a task projection is an allow-list and is frozen', () => {
  const p = projectTask({ id: 't_1', name: 'T', archivedAt: 5, todos: [{ id: 'x' }], links: ['l'] }, 't_1');
  assert.deepEqual(Object.keys(p).sort(), ['archived', 'archivedAt', 'createdAt', 'name', 'taskId']);
  assert.equal(p.archived, true);
  assert.ok(Object.isFrozen(p));
});

test('deepFreeze walks arrays and nested objects', () => {
  const o = deepFreeze({ a: [{ b: 1 }] });
  assert.ok(Object.isFrozen(o.a));
  assert.ok(Object.isFrozen(o.a[0]));
});
