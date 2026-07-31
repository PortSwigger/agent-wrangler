import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worktreeRemoveHandler, branchDeleteHandler } from './worktree.js';
import { createWorktree } from '../../worktree.js';

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-wth-'));
  const repo = path.join(root, 'myproj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# myproj\n');
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return fs.realpathSync(repo);
}

// ctx double: entryFor returns the given worktree entry; reply records frames.
function ctx(worktree) {
  const sent = [];
  return { sent, sessionManager: { entryFor: () => ({ worktree }) }, reply: (o) => sent.push(o) };
}

test('worktree-remove: removes a clean worktree and offers branch deletion', async () => {
  const repo = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'feat', auto: false });
  const c = ctx({ path: wt.path, branch: 'feat', repoRoot: repo });
  await worktreeRemoveHandler.handler({ type: 'worktree-remove', sessionId: 'S1' }, c);
  assert.deepEqual(c.sent, [{ type: 'worktree-removed', sessionId: 'S1', branch: 'feat', branchExists: true }]);
  assert.equal(fs.existsSync(wt.path), false);
});

test('worktree-remove: a dirty worktree replies blocked, then force removes', async () => {
  const repo = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'dirty', auto: false });
  fs.writeFileSync(path.join(wt.path, 'README.md'), '# changed\n');
  const c = ctx({ path: wt.path, branch: 'dirty', repoRoot: repo });
  await worktreeRemoveHandler.handler({ type: 'worktree-remove', sessionId: 'S1' }, c);
  assert.equal(c.sent[0].type, 'worktree-remove-blocked');
  assert.ok(c.sent[0].reason);
  assert.equal(fs.existsSync(wt.path), true);
  await worktreeRemoveHandler.handler({ type: 'worktree-remove', sessionId: 'S1', force: true }, c);
  assert.equal(c.sent[1].type, 'worktree-removed');
  assert.equal(fs.existsSync(wt.path), false);
});

test('worktree-remove: errors when no worktree is recorded', async () => {
  const c = ctx(null);
  await worktreeRemoveHandler.handler({ type: 'worktree-remove', sessionId: 'S1' }, c);
  assert.equal(c.sent[0].type, 'error');
});

test('branch-delete: deletes a merged branch', async () => {
  const repo = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'merged', auto: false });
  execFileSync('git', ['-C', repo, 'worktree', 'remove', wt.path], { stdio: 'pipe' });
  const c = ctx({ path: wt.path, branch: 'merged', repoRoot: repo });
  await branchDeleteHandler.handler({ type: 'branch-delete', sessionId: 'S1' }, c);
  assert.deepEqual(c.sent, [{ type: 'branch-deleted', sessionId: 'S1', branch: 'merged' }]);
});

test('branch-delete: an unmerged branch replies blocked, then force deletes', async () => {
  const repo = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'unmerged', auto: false });
  const git = (...a) => execFileSync('git', ['-C', wt.path, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  fs.writeFileSync(path.join(wt.path, 'x.txt'), 'work\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'work');
  execFileSync('git', ['-C', repo, 'worktree', 'remove', wt.path], { stdio: 'pipe' });
  const c = ctx({ path: wt.path, branch: 'unmerged', repoRoot: repo });
  await branchDeleteHandler.handler({ type: 'branch-delete', sessionId: 'S1' }, c);
  assert.equal(c.sent[0].type, 'branch-delete-blocked');
  assert.equal(c.sent[0].branch, 'unmerged');
  await branchDeleteHandler.handler({ type: 'branch-delete', sessionId: 'S1', force: true }, c);
  assert.equal(c.sent[1].type, 'branch-deleted');
});
