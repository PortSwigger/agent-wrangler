import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWorktreeHandler } from './validate-worktree.js';
import { createWorktree } from '../../worktree.js';

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vwh-'));
  const repo = path.join(root, 'myproj');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# myproj\n');
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return fs.realpathSync(repo);
}

function ctx() {
  const sent = [];
  return { sent, reply: (o) => sent.push(o) };
}

test('validate-worktree: no branch supplied → response carries no status/folderPath', async () => {
  const repo = tempRepo();
  const c = ctx();
  await validateWorktreeHandler.handler({ type: 'validate-worktree', cwd: repo }, c);
  assert.equal(c.sent[0].ok, true);
  assert.equal(c.sent[0].status, undefined);
  assert.equal(c.sent[0].folderPath, undefined);
});

test('validate-worktree: branch absent → status new with the default folder path', async () => {
  const repo = tempRepo();
  const c = ctx();
  await validateWorktreeHandler.handler({ type: 'validate-worktree', cwd: repo, branch: 'fresh' }, c);
  assert.equal(c.sent[0].ok, true);
  assert.equal(c.sent[0].status, 'new');
  assert.equal(c.sent[0].folderPath, path.join(path.dirname(repo), 'myproj-worktree-fresh'));
});

test('validate-worktree: existing branch with no worktree → status existing-branch', async () => {
  const repo = tempRepo();
  execFileSync('git', ['-C', repo, 'branch', 'have-it'], { stdio: 'pipe' });
  const c = ctx();
  await validateWorktreeHandler.handler({ type: 'validate-worktree', cwd: repo, branch: 'have-it' }, c);
  assert.equal(c.sent[0].status, 'existing-branch');
});

test('validate-worktree: adopting an existing worktree → status adopt with conflictPath', async () => {
  const repo = tempRepo();
  const wt = await createWorktree({ cwd: repo, branch: 'adopt-me', auto: false });
  const c = ctx();
  await validateWorktreeHandler.handler({ type: 'validate-worktree', cwd: repo, branch: 'adopt-me' }, c);
  assert.equal(c.sent[0].status, 'adopt');
  assert.equal(fs.realpathSync(c.sent[0].conflictPath), fs.realpathSync(wt.path));
});

test('validate-worktree: non-git cwd still replies ok:false even with a branch', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-nogit-')));
  const c = ctx();
  await validateWorktreeHandler.handler({ type: 'validate-worktree', cwd: dir, branch: 'x' }, c);
  assert.equal(c.sent[0].ok, false);
  assert.equal(c.sent[0].status, undefined);
});
