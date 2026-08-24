import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { viewDiffHandler } from './view-diff.js';

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vd-'));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return fs.realpathSync(repo);
}

// ctx double: entryFor returns the given entry; sessionFromGraph the given node.
function ctx({ entry = null, node = null, projectsDir = undefined, sessionLinks = [], taskLinks = [], prDiff = null } = {}) {
  const sent = [];
  return {
    sent,
    sessionManager: { entryFor: () => entry, getLinks: () => sessionLinks },
    taskStore: { taskFor: () => ({ id: 'T1' }), getLinks: () => taskLinks },
    sessionFromGraph: () => node,
    pullRequestDiff: prDiff,
    reply: (o) => sent.push(o),
    projectsDir,
  };
}

// A projects/ tree like ~/.claude/projects: <bucket>/<liveSessionId>.jsonl, with
// one cwd line per entry in `cwds` (in order — recentCwds sees them newest-last).
function tempTranscript(liveSessionId, cwds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vd-transcripts-'));
  const bucket = path.join(dir, 'bucket');
  fs.mkdirSync(bucket, { recursive: true });
  const lines = cwds.map((cwd) => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'x' } }));
  fs.writeFileSync(path.join(bucket, `${liveSessionId}.jsonl`), lines.join('\n') + '\n');
  return dir;
}

test('view-diff: replies a diff message from the entry cwd', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nCHANGED\n');
  const c = ctx({ entry: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);
  assert.equal(c.sent.length, 1);
  const r = c.sent[0];
  assert.equal(r.type, 'diff');
  assert.equal(r.sessionId, 'S1');
  assert.equal(r.state, 'ok');
  assert.ok(r.files.some((f) => f.path === 'tracked.txt'));
});

test('view-diff: prefers the worktree path over cwd', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nWT\n');
  const c = ctx({ entry: { cwd: '/nonexistent-cwd', worktree: { path: repo } } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);
  assert.equal(c.sent[0].state, 'ok');
});

test('view-diff: falls back to the graph node cwd', async () => {
  const repo = tempRepo();
  const c = ctx({ entry: null, node: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);
  assert.equal(c.sent[0].state, 'empty');
});

test('view-diff: state error when no working directory can be resolved', async () => {
  const c = ctx({ entry: null, node: null });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);
  assert.equal(c.sent[0].type, 'diff');
  assert.equal(c.sent[0].state, 'error');
});

test('view-diff: echoes the request reqId back on the reply (for stale-drop)', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nCHANGED\n');
  const c = ctx({ entry: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1', reqId: 42 }, c);
  assert.equal(c.sent[0].reqId, 42);
});

test('view-diff: echoes reqId on the error reply too, so a failed poll clears in-flight', async () => {
  const c = ctx({ entry: null, node: null });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1', reqId: 7 }, c);
  assert.equal(c.sent[0].state, 'error');
  assert.equal(c.sent[0].reqId, 7);
});

test('view-diff: omits reqId when the client sent none (backward compatible)', async () => {
  const repo = tempRepo();
  const c = ctx({ entry: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);
  assert.equal('reqId' in JSON.parse(JSON.stringify(c.sent[0])), false);
});

test('view-diff: defaults to working-tree mode and echoes it', async () => {
  const repo = tempRepo();
  const c = ctx({ entry: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);
  assert.equal(c.sent[0].mode, 'working-tree');
});

test('view-diff: mode "branch" routes to branchDiff (no-remote for a repo with no remote)', async () => {
  const repo = tempRepo();
  const c = ctx({ entry: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1', mode: 'branch' }, c);
  assert.equal(c.sent[0].mode, 'branch');
  assert.equal(c.sent[0].state, 'no-remote');
});

test('view-diff: an unrecognised mode falls back to working-tree', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nCHANGED\n');
  const c = ctx({ entry: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1', mode: 'bogus' }, c);
  assert.equal(c.sent[0].mode, 'working-tree');
  assert.equal(c.sent[0].state, 'ok');
});

test('view-diff: mode "pr" routes to the selected linked PR diff', async () => {
  const calls = [];
  const prUrl = 'https://github.com/acme/widgets/pull/42';
  const c = ctx({
    sessionLinks: [{ type: 'pr', url: prUrl, repo: 'acme/widgets', number: 42 }],
    prDiff: async (url) => {
      calls.push(url);
      return { state: 'ok', files: [{ path: 'a.js', hunks: [] }], truncated: { droppedLines: 0, droppedFiles: 0 } };
    },
  });

  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1', reqId: 9, mode: 'pr', prUrl }, c);

  assert.deepEqual(calls, [prUrl]);
  assert.equal(c.sent[0].type, 'diff');
  assert.equal(c.sent[0].sessionId, 'S1');
  assert.equal(c.sent[0].reqId, 9);
  assert.equal(c.sent[0].mode, 'pr');
  assert.equal(c.sent[0].prUrl, prUrl);
  assert.equal(c.sent[0].prRepo, 'acme/widgets');
  assert.equal(c.sent[0].prNumber, 42);
  assert.equal(c.sent[0].state, 'ok');
});

test('view-diff: mode "pr" can use a PR linked on the assigned task', async () => {
  const prUrl = 'https://github.com/acme/widgets/pull/43';
  const c = ctx({
    taskLinks: [{ type: 'pr', url: prUrl, repo: 'acme/widgets', number: 43 }],
    prDiff: async () => ({ state: 'empty' }),
  });

  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1', mode: 'pr', prUrl }, c);

  assert.equal(c.sent[0].mode, 'pr');
  assert.equal(c.sent[0].prNumber, 43);
  assert.equal(c.sent[0].state, 'empty');
});

test('view-diff: mode "pr" rejects an unlinked PR URL', async () => {
  const calls = [];
  const c = ctx({
    sessionLinks: [{ type: 'pr', url: 'https://github.com/acme/widgets/pull/42', repo: 'acme/widgets', number: 42 }],
    prDiff: async (url) => { calls.push(url); return { state: 'empty' }; },
  });

  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1', reqId: 10, mode: 'pr', prUrl: 'https://github.com/acme/widgets/pull/99' }, c);

  assert.deepEqual(calls, []);
  assert.equal(c.sent[0].mode, 'pr');
  assert.equal(c.sent[0].reqId, 10);
  assert.equal(c.sent[0].state, 'error');
  assert.match(c.sent[0].error, /not linked/i);
});

test('view-diff: falls back to the transcript\'s drifted cwd when the launch cwd is not a repo', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nCHANGED\n');
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vd-notrepo-'));
  const projectsDir = tempTranscript('LIVE1', [notARepo, repo]);
  const c = ctx({ entry: { cwd: notARepo, liveSessionId: 'LIVE1' }, projectsDir });

  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);

  assert.equal(c.sent[0].state, 'ok');
  assert.equal(c.sent[0].cwd, repo);
});

test('view-diff: keeps finding the drifted repo after a resume reverts the newest transcript line back to the launch dir', async () => {
  // Reproduces the diff-comments regression: submitting a comment on a dormant
  // session resumes it, and the freshly-launched process's first lines land back
  // at the launch dir (its own Bash-tool cwd tracking starts over there) even
  // though the agent's real work is still in the repo it drifted to before going
  // dormant. The newest line is the launch dir again; the real repo is the next
  // distinct cwd back, not the tail.
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nCHANGED\n');
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-vd-notrepo-'));
  const projectsDir = tempTranscript('LIVE3', [notARepo, repo, notARepo]);
  const c = ctx({ entry: { cwd: notARepo, liveSessionId: 'LIVE3' }, projectsDir });

  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);

  assert.equal(c.sent[0].state, 'ok');
  assert.equal(c.sent[0].cwd, repo);
});

test('view-diff: does not use the drifted cwd when the launch cwd is a real (if empty) repo', async () => {
  const repo = tempRepo();
  const otherRepo = tempRepo();
  fs.writeFileSync(path.join(otherRepo, 'tracked.txt'), 'one\nCHANGED\n');
  const projectsDir = tempTranscript('LIVE2', [repo, otherRepo]);
  const c = ctx({ entry: { cwd: repo, liveSessionId: 'LIVE2' }, projectsDir });

  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);

  assert.equal(c.sent[0].state, 'empty');
  assert.equal('cwd' in JSON.parse(JSON.stringify(c.sent[0])), false);
});

test('view-diff: omits cwd on the reply when no drift was needed (backward compatible)', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\nCHANGED\n');
  const c = ctx({ entry: { cwd: repo } });
  await viewDiffHandler.handler({ type: 'view-diff', sessionId: 'S1' }, c);
  assert.equal('cwd' in JSON.parse(JSON.stringify(c.sent[0])), false);
});
