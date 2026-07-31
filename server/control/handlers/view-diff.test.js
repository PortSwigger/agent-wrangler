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
function ctx({ entry = null, node = null } = {}) {
  const sent = [];
  return { sent, sessionManager: { entryFor: () => entry }, sessionFromGraph: () => node, reply: (o) => sent.push(o) };
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
