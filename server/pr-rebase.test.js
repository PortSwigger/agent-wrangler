import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attemptLinkedPrRebase, linkedPrCheckoutKey } from './pr-rebase.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REBASED = 'cccccccccccccccccccccccccccccccccccccccc';
const PR = {
  head: { repo: 'acme/project', ref: 'feature', oid: HEAD },
  base: { repo: 'acme/project', ref: 'main', oid: BASE },
  crossRepository: false,
};

function scriptedGit(steps) {
  const calls = [];
  const run = async (cwd, args) => {
    calls.push({ cwd, args });
    const step = steps.shift();
    assert.deepEqual(args, step.args);
    return { code: 0, stdout: '', stderr: '', ...step.result };
  };
  return { calls, run };
}

function readySteps() {
  const gate = () => [
    { args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], result: { stdout: 'feature\n' } },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
    { args: ['status', '--porcelain=v1', '--untracked-files=no'] },
    { args: ['rev-parse', '--git-path', 'rebase-merge'], result: { stdout: '/repo/.git/rebase-merge\n' } },
    { args: ['rev-parse', '--git-path', 'rebase-apply'], result: { stdout: '/repo/.git/rebase-apply\n' } },
    { args: ['rev-parse', '--git-path', 'MERGE_HEAD'], result: { stdout: '/repo/.git/MERGE_HEAD\n' } },
    { args: ['rev-parse', '--git-path', 'CHERRY_PICK_HEAD'], result: { stdout: '/repo/.git/CHERRY_PICK_HEAD\n' } },
    { args: ['rev-parse', '--git-path', 'REVERT_HEAD'], result: { stdout: '/repo/.git/REVERT_HEAD\n' } },
    { args: ['rev-parse', '--git-path', 'sequencer'], result: { stdout: '/repo/.git/sequencer\n' } },
  ];
  return [
    { args: ['remote', '-v'], result: { stdout: 'origin\thttps://github.com/Acme/Project.git (fetch)\norigin\thttps://github.com/Acme/Project.git (push)\n' } },
    ...gate(),
    { args: ['fetch', '--no-tags', 'origin', BASE] },
    { args: ['rev-parse', 'FETCH_HEAD'], result: { stdout: `${BASE}\n` } },
    { args: ['ls-remote', 'origin', 'refs/heads/main'], result: { stdout: `${BASE}\trefs/heads/main\n` } },
    ...gate(),
    { args: ['merge-base', '--is-ancestor', BASE, HEAD], result: { code: 1 } },
  ];
}

test('canonical checkout keys collapse symlink aliases onto one worktree root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-rebase-root-'));
  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias);
  t.after(() => {
    fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runGit = async (cwd, args) => {
    assert.deepEqual(args, ['rev-parse', '--show-toplevel']);
    return { code: 0, stdout: `${cwd}\n`, stderr: '' };
  };

  assert.equal(await linkedPrCheckoutKey(root, runGit), await linkedPrCheckoutKey(alias, runGit));
});

test('rebases the exact linked head onto the fetched base and pushes with an explicit lease', async () => {
  const git = scriptedGit([
    ...readySteps(),
    { args: ['rebase', '--rebase-merges', BASE] },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${REBASED}\n` } },
    { args: ['push', `--force-with-lease=refs/heads/feature:${HEAD}`, 'origin', `${REBASED}:refs/heads/feature`] },
  ]);
  let idleChecks = 0;

  const result = await attemptLinkedPrRebase({
    cwd: '/repo',
    rebase: PR,
    isIdle: () => { idleChecks += 1; return true; },
    pathExists: () => false,
  }, git.run);

  assert.deepEqual(result, { kind: 'rebased', oldHead: HEAD, newHead: REBASED, base: BASE });
  assert.equal(idleChecks, 4);
  assert.equal(git.calls.length, 26);
});

test('leaves the rewritten head untouched when the session stops being idle', async () => {
  const git = scriptedGit([
    ...readySteps(),
    { args: ['rebase', '--rebase-merges', BASE] },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${REBASED}\n` } },
  ]);
  let idleChecks = 0;

  const result = await attemptLinkedPrRebase({
    cwd: '/repo',
    rebase: PR,
    isIdle: () => { idleChecks += 1; return idleChecks < 4; },
    pathExists: () => false,
  }, git.run);

  assert.deepEqual(result, { kind: 'failed', reason: 'session-became-busy-local-rewrite', restored: false });
  assert.equal(git.calls.length, 25);
});

test('leaves the rewritten head untouched after a rejected push', async () => {
  const git = scriptedGit([
    ...readySteps(),
    { args: ['rebase', '--rebase-merges', BASE] },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${REBASED}\n` } },
    { args: ['push', `--force-with-lease=refs/heads/feature:${HEAD}`, 'origin', `${REBASED}:refs/heads/feature`], result: { code: 1, stderr: 'rejected\n' } },
    { args: ['ls-remote', 'origin', 'refs/heads/feature'], result: { stdout: `${HEAD}\trefs/heads/feature\n` } },
  ]);

  const result = await attemptLinkedPrRebase({
    cwd: '/repo', rebase: PR, isIdle: () => true, pathExists: () => false,
  }, git.run);

  assert.deepEqual(result, {
    kind: 'failed', reason: 'push-failed-local-rewrite', detail: 'rejected', restored: false,
  });
});

test('treats an ambiguous push error as success when the remote has the rewritten head', async () => {
  const git = scriptedGit([
    ...readySteps(),
    { args: ['rebase', '--rebase-merges', BASE] },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${REBASED}\n` } },
    { args: ['push', `--force-with-lease=refs/heads/feature:${HEAD}`, 'origin', `${REBASED}:refs/heads/feature`], result: { code: 1, stderr: 'connection lost\n' } },
    { args: ['ls-remote', 'origin', 'refs/heads/feature'], result: { stdout: `${REBASED}\trefs/heads/feature\n` } },
  ]);

  const result = await attemptLinkedPrRebase({
    cwd: '/repo', rebase: PR, isIdle: () => true, pathExists: () => false,
  }, git.run);

  assert.deepEqual(result, { kind: 'rebased', oldHead: HEAD, newHead: REBASED, base: BASE });
});

test('does not run a destructive recovery command after a push failure', async () => {
  const git = scriptedGit([
    ...readySteps(),
    { args: ['rebase', '--rebase-merges', BASE] },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${REBASED}\n` } },
    { args: ['push', `--force-with-lease=refs/heads/feature:${HEAD}`, 'origin', `${REBASED}:refs/heads/feature`], result: { code: 1, stderr: 'rejected\n' } },
    { args: ['ls-remote', 'origin', 'refs/heads/feature'], result: { stdout: `${HEAD}\trefs/heads/feature\n` } },
  ]);

  const result = await attemptLinkedPrRebase({
    cwd: '/repo', rebase: PR, isIdle: () => true, pathExists: () => false,
  }, git.run);

  assert.deepEqual(result, {
    kind: 'failed', reason: 'push-failed-local-rewrite', detail: 'rejected', restored: false,
  });
});

test('rechecks eligibility immediately before rewriting local history', async () => {
  const git = scriptedGit(readySteps());
  let eligibilityChecks = 0;

  const result = await attemptLinkedPrRebase({
    cwd: '/repo',
    rebase: PR,
    isIdle: () => { eligibilityChecks += 1; return eligibilityChecks < 3; },
    pathExists: () => false,
  }, git.run);

  assert.deepEqual(result, { kind: 'deferred', reason: 'session-busy' });
  assert.equal(git.calls.length, 23);
});

test('does not mutate the branch when eligibility changes during the fetch', async () => {
  const git = scriptedGit(readySteps().slice(0, 13));
  let eligibilityChecks = 0;

  const result = await attemptLinkedPrRebase({
    cwd: '/repo',
    rebase: PR,
    isIdle: () => { eligibilityChecks += 1; return eligibilityChecks < 2; },
    pathExists: () => false,
  }, git.run);

  assert.deepEqual(result, { kind: 'deferred', reason: 'session-busy' });
  assert.equal(git.calls.length, 13);
});

test('fetches the base and pushes the head through their matching remotes for a fork PR', async () => {
  const forkPr = {
    ...PR,
    head: { ...PR.head, repo: 'contributor/project' },
    crossRepository: true,
  };
  const steps = readySteps();
  steps[0].result.stdout = [
    'upstream\thttps://github.com/acme/project.git (fetch)',
    'upstream\thttps://github.com/acme/project.git (push)',
    'fork\tgit@github.com:contributor/project.git (fetch)',
    'fork\tgit@github.com:contributor/project.git (push)',
    '',
  ].join('\n');
  steps[10].args[2] = 'upstream';
  steps[12].args[1] = 'upstream';
  const git = scriptedGit([
    ...steps,
    { args: ['rebase', '--rebase-merges', BASE] },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${REBASED}\n` } },
    { args: ['push', `--force-with-lease=refs/heads/feature:${HEAD}`, 'fork', `${REBASED}:refs/heads/feature`] },
  ]);

  const result = await attemptLinkedPrRebase({
    cwd: '/repo', rebase: forkPr, isIdle: () => true, pathExists: () => false,
  }, git.run);

  assert.equal(result.kind, 'rebased');
});

test('leaves a conflicted rebase in place and reports a conflict for the session to resolve', async () => {
  const git = scriptedGit([
    ...readySteps(),
    { args: ['rebase', '--rebase-merges', BASE], result: { code: 1, stderr: 'Could not apply commit\nmore detail\n' } },
    { args: ['rev-parse', '--git-path', 'rebase-merge'], result: { stdout: '/repo/.git/rebase-merge\n' } },
  ]);
  let pathChecks = 0;

  const result = await attemptLinkedPrRebase({
    cwd: '/repo',
    rebase: PR,
    isIdle: () => true,
    pathExists: () => { pathChecks += 1; return pathChecks === 13; },
  }, git.run);

  assert.deepEqual(result, { kind: 'conflict', reason: 'rebase-conflict', detail: 'Could not apply commit' });
});

test('silently defers when another git operation is in progress', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-rebase-state-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.git', 'rebase-merge'), { recursive: true });
  const git = scriptedGit([
    { args: ['remote', '-v'], result: { stdout: 'origin\thttps://github.com/acme/project.git (fetch)\norigin\thttps://github.com/acme/project.git (push)\n' } },
    { args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], result: { stdout: 'feature\n' } },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
    { args: ['status', '--porcelain=v1', '--untracked-files=no'] },
    { args: ['rev-parse', '--git-path', 'rebase-merge'], result: { stdout: '.git/rebase-merge\n' } },
  ]);

  const result = await attemptLinkedPrRebase({ cwd, rebase: PR, isIdle: () => true }, git.run);

  assert.deepEqual(result, { kind: 'deferred', reason: 'operation-in-progress' });
});

test('does no git work unless the session is idle', async () => {
  const result = await attemptLinkedPrRebase({
    cwd: '/repo', rebase: PR, isIdle: () => false,
  }, async () => { throw new Error('git must not run'); });
  assert.deepEqual(result, { kind: 'deferred', reason: 'session-busy' });
});

test('silently skips a linked PR whose head branch is not checked out', async () => {
  const git = scriptedGit([
    { args: ['remote', '-v'], result: { stdout: 'origin\thttps://github.com/acme/project.git (fetch)\norigin\thttps://github.com/acme/project.git (push)\n' } },
    { args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], result: { stdout: 'some-other-branch\n' } },
  ]);
  const result = await attemptLinkedPrRebase({ cwd: '/repo', rebase: PR, isIdle: () => true }, git.run);
  assert.deepEqual(result, { kind: 'skipped', reason: 'branch-mismatch' });
});

test('silently defers a checkout with tracked changes', async () => {
  const git = scriptedGit([
    { args: ['remote', '-v'], result: { stdout: 'origin\thttps://github.com/acme/project.git (fetch)\norigin\thttps://github.com/acme/project.git (push)\n' } },
    { args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], result: { stdout: 'feature\n' } },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${HEAD}\n` } },
    { args: ['status', '--porcelain=v1', '--untracked-files=no'], result: { stdout: ' M notes.txt\n' } },
  ]);
  const result = await attemptLinkedPrRebase({ cwd: '/repo', rebase: PR, isIdle: () => true }, git.run);
  assert.deepEqual(result, { kind: 'deferred', reason: 'dirty-worktree' });
});

test('silently skips when local HEAD has moved beyond the linked PR head', async () => {
  const git = scriptedGit([
    { args: ['remote', '-v'], result: { stdout: 'origin\thttps://github.com/acme/project.git (fetch)\norigin\thttps://github.com/acme/project.git (push)\n' } },
    { args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], result: { stdout: 'feature\n' } },
    { args: ['rev-parse', 'HEAD'], result: { stdout: `${REBASED}\n` } },
  ]);
  const result = await attemptLinkedPrRebase({ cwd: '/repo', rebase: PR, isIdle: () => true }, git.run);
  assert.deepEqual(result, { kind: 'skipped', reason: 'head-mismatch' });
});

test('does not rebase when the fetched base is already an ancestor of the PR head', async () => {
  const steps = readySteps();
  steps.at(-1).result.code = 0;
  const git = scriptedGit(steps);
  const result = await attemptLinkedPrRebase({
    cwd: '/repo', rebase: PR, isIdle: () => true, pathExists: () => false,
  }, git.run);
  assert.deepEqual(result, { kind: 'deferred', reason: 'already-current' });
});

test('defers when the base moves between GitHub status and fetch', async () => {
  const steps = readySteps().slice(0, 13);
  steps.at(-1).result.stdout = `${REBASED}\trefs/heads/main\n`;
  const git = scriptedGit(steps);
  const result = await attemptLinkedPrRebase({
    cwd: '/repo', rebase: PR, isIdle: () => true, pathExists: () => false,
  }, git.run);
  assert.deepEqual(result, { kind: 'deferred', reason: 'base-moved' });
});
