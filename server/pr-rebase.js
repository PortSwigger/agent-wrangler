import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function defaultRunGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function repoFromRemote(url) {
  const match = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/i.exec(String(url).trim());
  return match?.[1];
}

function remotesByRepo(output) {
  const repos = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
    if (!match) continue;
    const [, remote, url, direction] = match;
    const repo = repoFromRemote(url)?.toLowerCase();
    if (!repo) continue;
    const entry = repos.get(repo) || {};
    entry[direction] = remote;
    repos.set(repo, entry);
  }
  return repos;
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).find(Boolean) || '';
}

export async function linkedPrCheckoutKey(cwd, runGit = defaultRunGit) {
  const root = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const candidate = root.code === 0 && root.stdout.trim() ? root.stdout.trim() : cwd;
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function safetyState(cwd, rebase, pathExists, runGit) {
  const branch = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.code !== 0 || branch.stdout.trim() !== rebase.head.ref) return { kind: 'skipped', reason: 'branch-mismatch' };
  const head = await runGit(cwd, ['rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== rebase.head.oid) return { kind: 'skipped', reason: 'head-mismatch' };
  const status = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (status.code !== 0) return { kind: 'failed', reason: 'status-check-failed' };
  if (status.stdout) return { kind: 'deferred', reason: 'dirty-worktree' };
  for (const state of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']) {
    const gitPath = await runGit(cwd, ['rev-parse', '--git-path', state]);
    if (gitPath.code !== 0) return { kind: 'failed', reason: 'git-state-check-failed' };
    if (pathExists(gitPath.stdout.trim())) return { kind: 'deferred', reason: 'operation-in-progress' };
  }
  return null;
}

export async function attemptLinkedPrRebase({ cwd, rebase, isIdle, pathExists }, runGit = defaultRunGit) {
  if (!await isIdle()) return { kind: 'deferred', reason: 'session-busy' };
  const exists = pathExists || ((candidate) => fs.existsSync(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate)));

  const remoteResult = await runGit(cwd, ['remote', '-v']);
  if (remoteResult.code !== 0) return { kind: 'failed', reason: 'remote-list-failed' };
  const remotes = remotesByRepo(remoteResult.stdout);
  const baseRemote = remotes.get(rebase.base.repo.toLowerCase())?.fetch;
  const headRemote = remotes.get(rebase.head.repo.toLowerCase())?.push;
  if (!baseRemote || !headRemote) return { kind: 'failed', reason: 'remote-not-found' };

  const before = await safetyState(cwd, rebase, exists, runGit);
  if (before) return before;

  const fetched = await runGit(cwd, ['fetch', '--no-tags', baseRemote, rebase.base.oid]);
  if (fetched.code !== 0) return { kind: 'failed', reason: 'fetch-failed' };
  const fetchedHead = await runGit(cwd, ['rev-parse', 'FETCH_HEAD']);
  if (fetchedHead.code !== 0) return { kind: 'failed', reason: 'fetch-head-missing' };
  if (fetchedHead.stdout.trim() !== rebase.base.oid) return { kind: 'deferred', reason: 'base-moved' };
  const currentBase = await runGit(cwd, ['ls-remote', baseRemote, `refs/heads/${rebase.base.ref}`]);
  if (currentBase.code !== 0) return { kind: 'failed', reason: 'base-ref-check-failed' };
  if (currentBase.stdout.trim().split(/\s/)[0] !== rebase.base.oid) return { kind: 'deferred', reason: 'base-moved' };
  if (!await isIdle()) return { kind: 'deferred', reason: 'session-busy' };

  const afterFetch = await safetyState(cwd, rebase, exists, runGit);
  if (afterFetch) return afterFetch;

  const ancestor = await runGit(cwd, ['merge-base', '--is-ancestor', rebase.base.oid, rebase.head.oid]);
  if (ancestor.code === 0) return { kind: 'deferred', reason: 'already-current' };
  if (ancestor.code !== 1) return { kind: 'failed', reason: 'ancestry-check-failed' };
  if (!await isIdle()) return { kind: 'deferred', reason: 'session-busy' };

  const rebased = await runGit(cwd, ['rebase', '--rebase-merges', rebase.base.oid]);
  if (rebased.code !== 0) {
    for (const state of ['rebase-merge', 'rebase-apply']) {
      const gitPath = await runGit(cwd, ['rev-parse', '--git-path', state]);
      if (gitPath.code === 0 && exists(gitPath.stdout.trim())) {
        return { kind: 'conflict', reason: 'rebase-conflict', detail: firstLine(rebased.stderr) };
      }
    }
    return { kind: 'failed', reason: 'rebase-failed', detail: firstLine(rebased.stderr) };
  }
  const newHead = await runGit(cwd, ['rev-parse', 'HEAD']);
  if (newHead.code !== 0) return { kind: 'failed', reason: 'new-head-missing-local-rewrite', restored: false };
  const newOid = newHead.stdout.trim();
  if (!await isIdle()) {
    return { kind: 'failed', reason: 'session-became-busy-local-rewrite', restored: false };
  }
  const pushed = await runGit(cwd, [
    'push',
    `--force-with-lease=refs/heads/${rebase.head.ref}:${rebase.head.oid}`,
    headRemote,
    `${newOid}:refs/heads/${rebase.head.ref}`,
  ]);
  if (pushed.code !== 0) {
    const remoteHead = await runGit(cwd, ['ls-remote', headRemote, `refs/heads/${rebase.head.ref}`]);
    const remoteOid = remoteHead.code === 0 ? remoteHead.stdout.trim().split(/\s/)[0] : '';
    if (remoteOid === newOid) {
      return { kind: 'rebased', oldHead: rebase.head.oid, newHead: newOid, base: rebase.base.oid };
    }
    return {
      kind: 'failed',
      reason: 'push-failed-local-rewrite',
      detail: firstLine(pushed.stderr),
      restored: false,
    };
  }
  return { kind: 'rebased', oldHead: rebase.head.oid, newHead: newOid, base: rebase.base.oid };
}
