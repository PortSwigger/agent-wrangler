import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectPrepare } from './session-prepare.js';
import { VALUE_HOOKS } from './extensions/index.js';
import { repoRootOf } from './worktree.js';
import { SessionManager } from './session-manager.js';

const registry = (...rows) => ({ hooks: { 'session.prepare': rows.map(([extId, fn]) => ({ extId, fn })) } });
const quiet = () => {
  const errors = [];
  return { errors, onError: (...a) => errors.push(a.map(String).join(' ')) };
};

test('session.prepare is a known value hook', () => {
  assert.ok(VALUE_HOOKS.includes('session.prepare'));
});

test('hooks run in order with the payload plus their own host, warnings accumulate', async () => {
  const seen = [];
  const ext = registry(
    ['a', async (p) => { seen.push(['a', p]); return { warnings: ['w1'] }; }],
    ['b', (p) => { seen.push(['b', p]); return { warnings: ['w2', '', 7] }; }],
    ['c', () => undefined],
  );
  const out = await collectPrepare({ sessionId: 's', cwd: '/x' }, { ext, hostApiFor: (id) => ({ id }), onError: () => {} });
  assert.deepEqual(out, { abort: null, warnings: ['w1', 'w2'] });
  assert.deepEqual(seen.map(([id, p]) => [id, p.sessionId, p.host]), [['a', 's', { id: 'a' }], ['b', 's', { id: 'b' }]]);
});

test('abort stops the chain and keeps warnings gathered so far', async () => {
  let ranC = false;
  const ext = registry(
    ['a', () => ({ warnings: ['w'] })],
    ['b', () => ({ abort: 'main is dirty' })],
    ['c', () => { ranC = true; }],
  );
  const out = await collectPrepare({}, { ext, onError: () => {} });
  assert.deepEqual(out, { abort: 'main is dirty', warnings: ['w'] });
  assert.equal(ranC, false);
});

test('a throwing hook and a bad return are logged and skipped', async () => {
  const { errors, onError } = quiet();
  const ext = registry(['a', () => { throw new Error('boom'); }], ['b', () => 'nope'], ['c', () => ({ warnings: ['ok'] })]);
  const out = await collectPrepare({}, { ext, onError });
  assert.deepEqual(out, { abort: null, warnings: ['ok'] });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /\[ext:a\] session.prepare failed/);
  assert.match(errors[1], /\[ext:b\] session.prepare must return/);
});

test('a hook that overruns the timeout is logged and does not block', async () => {
  const { errors, onError } = quiet();
  const ext = registry(['slow', () => new Promise(() => {})], ['b', () => ({ warnings: ['after'] })]);
  const out = await collectPrepare({}, { ext, onError, timeoutMs: 20 });
  assert.deepEqual(out, { abort: null, warnings: ['after'] });
  assert.match(errors[0], /timed out/);
});

function repoFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-prepare-')));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
  return { root, repo };
}

function manager() {
  const sm = new SessionManager();
  sm._save = () => {};
  sm.refreshAlive = async () => {};
  sm.killForSession = async () => {};
  sm._newSession = async () => {};
  return sm;
}

test('repoRootOf: toplevel inside a repo, null outside', async () => {
  const { repo } = repoFixture();
  assert.equal(await repoRootOf(path.join(repo)), repo);
  assert.equal(await repoRootOf(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-norepo-'))), null);
});

test('dispatch runs session.prepare before the worktree exists, with the documented payload', async () => {
  const { repo } = repoFixture();
  const sm = manager();
  const calls = [];
  sm._prepare = async (p) => {
    calls.push({ ...p, worktrees: fs.readdirSync(path.dirname(repo)) });
    return { abort: null, warnings: [] };
  };
  let launchedCwd;
  sm._newSession = async (_t, cwd) => { launchedCwd = cwd; };
  const { sessionId } = await sm.dispatch({ cwd: repo, intent: 'x', worktree: true, worktreeAuto: true, taskId: 'T1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { ...calls[0], worktrees: undefined },
    { sessionId, taskId: 'T1', cwd: repo, repoRoot: repo, willCreateWorktree: true, agent: 'claude', worktrees: undefined },
  );
  assert.deepEqual(calls[0].worktrees, ['proj'], 'no sibling worktree folder yet');
  assert.notEqual(launchedCwd, repo, 'the worktree was created after the hook');
});

test('abort fails the dispatch with no worktree, no pane and no entry', async () => {
  const { repo } = repoFixture();
  const sm = manager();
  const before = sm.map.size;
  let launched = false;
  sm._newSession = async () => { launched = true; };
  sm._prepare = async () => ({ abort: 'git pull failed', warnings: [] });
  await assert.rejects(() => sm.dispatch({ cwd: repo, intent: 'x', worktree: true, worktreeAuto: true }), /git pull failed/);
  assert.equal(launched, false);
  assert.equal(sm.map.size, before);
  assert.deepEqual(fs.readdirSync(path.dirname(repo)), ['proj']);
  assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n').length, 1);
});

test('warnings do not block the launch', async () => {
  const sm = manager();
  let launched = false;
  sm._newSession = async () => { launched = true; };
  sm._prepare = async () => ({ abort: null, warnings: ['stale main'] });
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.equal(launched, true);
});

test('a throwing or timing-out extension never blocks dispatch (through collectPrepare)', async () => {
  const sm = manager();
  const { onError } = quiet();
  const ext = registry(['bad', () => { throw new Error('x'); }], ['slow', () => new Promise(() => {})]);
  sm._prepare = (p) => collectPrepare(p, { ext, onError, timeoutMs: 20 });
  let launched = false;
  sm._newSession = async () => { launched = true; };
  await sm.dispatch({ cwd: os.tmpdir(), intent: 'x' });
  assert.equal(launched, true);
});

test('resume and fork do not fire session.prepare', async () => {
  const sm = manager();
  let n = 0;
  sm._prepare = async () => { n++; return { abort: 'no', warnings: [] }; };
  sm.map.set('CARD1', { tmux: 'cx_a', cwd: os.tmpdir(), agent: 'codex', liveSessionId: 'ROLL-1' });
  await sm.resume('CARD1', os.tmpdir());
  await sm.fork({ sourceId: 'SRC', parentId: 'CARD1', parentEntry: { agent: 'codex', cwd: os.tmpdir() }, cwd: os.tmpdir() });
  assert.equal(n, 0);
});
