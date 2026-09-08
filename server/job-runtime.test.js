import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobRuntime } from './job-runtime.js';
import { JobStore } from './job-store.js';
import { JobRunner } from './job-runner.js';
import { jobPrompt } from './job-prompts.js';
import { SessionManager, resumeEntry, SESSIONS_DIR } from './session-manager.js';
import { DATA_DIR } from './data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const job = { id: 'job_12345678', title: 'Sign-in', intent: 'Reliable sign-in', repos: ['/repo'], agent: 'claude', model: '', taskId: null, plan: { stories: [] } };
const run = { id: 'run1', phase: 'implementation' };
const sub = { id: 'api', repo: '/repo', jiraKey: 'AUTH-1' };

test('a planning session survives a board refresh while its pane is still running', async () => {
  const manager = new SessionManager(); manager.map.clear();
  manager.map.set('sid', { tmux: 'cx_new', socket: 'preview' });
  manager.alive.add('cx_new');
  let release, stops = 0;
  manager._tmux = async (_socket, args) => args.includes('-a')
    ? new Promise(resolve => { release = () => resolve({ stdout: 'cx_new\x1f0\x1f\n' }); })
    : { stdout: '0\n' };
  manager.suspend = async () => { stops++; };
  const store = new JobStore(path.join(DATA_DIR, 'refresh-race-jobs.json'));
  const job = store.create({ title: 'Discover repositories', intent: 'Plan the rename', agent: 'codex' });
  store.action(job.id, 'start');
  const run = store.claim(job.id, null, 'planning');
  store.bindRun(job.id, run.id, 'sid');
  const runtime = new JobRuntime({ sessionManager: manager });
  const runner = new JobRunner({ store, runtime });
  const refreshing = manager.refreshAlive();
  try {
    await runner.tick();
    assert.equal(stops, 0, 'the runner must not suspend a live worker');
    assert.equal(store.get(job.id).runs[0].stopped, false);
    assert.equal(store.get(job.id).error, undefined);
  } finally { release(); await refreshing; }
});

test('board liveness remains a complete snapshot until refresh finishes', async () => {
  const manager = new SessionManager(); manager.map.clear();
  manager.alive = new Set(['cx_live']);
  manager.dead = new Set(['cx_dead']);
  manager.deadStatus = new Map([['cx_dead', 1]]);
  manager.socketByName = new Map([['cx_live', 'preview']]);
  manager.scanSockets = () => ['preview'];
  let release;
  manager._tmux = async () => new Promise(resolve => { release = resolve; });
  const refreshing = manager.refreshAlive();
  try {
    assert.deepEqual([...manager.alive], ['cx_live']);
    assert.deepEqual([...manager.dead], ['cx_dead']);
    assert.equal(manager.deadStatus.get('cx_dead'), 1);
    assert.equal(manager.socketByName.get('cx_live'), 'preview');
  } finally { release({ stdout: 'cx_new\x1f0\x1f\n' }); await refreshing; }
  assert.deepEqual([...manager.alive], ['cx_new']);
  assert.equal(manager.dead.size, 0);
  assert.equal(manager.deadStatus.size, 0);
});

test('job liveness probes the exact session on its recorded socket and checks every pane', async () => {
  const manager = new SessionManager(); manager.map.clear();
  manager.map.set('sid', { tmux: 'cx_worker', socket: 'preview' });
  manager.socketByName.set('cx_worker', 'stale-socket');
  const runtime = new JobRuntime({ sessionManager: manager });
  for (const [stdout, expected] of [['0\n', true], ['1\n0\n', true], ['1\n1\n', false]]) {
    manager._tmux = async (socket, args, opts) => {
      assert.equal(socket, 'preview');
      assert.deepEqual(args, ['list-panes', '-s', '-t', '=cx_worker', '-F', '#{pane_dead}']);
      assert.equal(opts.timeout, 5000);
      return { stdout };
    };
    assert.equal(await runtime.isAlive({ sessionId: 'sid' }), expected);
  }
  manager._tmux = async () => assert.fail('missing mappings do not probe another session');
  assert.equal(await runtime.isAlive({ sessionId: 'missing' }), false);
});

test('only confirmed missing sessions count as stopped; probe failures remain errors', async () => {
  const manager = new SessionManager(); manager.map.clear();
  manager.map.set('sid', { tmux: 'cx_worker', socket: 'preview' });
  for (const stderr of ["can't find session: cx_worker", "can't find window: cx_worker", 'no server running on /socket', 'error connecting to /socket (No such file or directory)', 'error connecting to /socket (Connection refused)']) {
    manager._tmux = async () => { throw Object.assign(new Error(stderr), { code: 1, stderr }); };
    assert.equal(await manager.isSessionAlive('sid'), false);
  }
  for (const error of [
    Object.assign(new Error('permission denied'), { code: 1, stderr: 'error connecting to /socket (Operation not permitted)' }),
    Object.assign(new Error('too many files'), { code: 'EMFILE' }),
    Object.assign(new Error('missing binary'), { code: 'ENOENT' }),
    Object.assign(new Error('timeout'), { killed: true }),
  ]) {
    manager._tmux = async () => { throw error; };
    await assert.rejects(manager.isSessionAlive('sid'), e => e === error);
  }
  manager._tmux = async () => ({ stdout: '' });
  await assert.rejects(manager.isSessionAlive('sid'), /Cannot determine/);
});

test('a submitted receipt releases its slot after tmux removes the stopped session', async () => {
  const manager = new SessionManager(); manager.map.clear();
  manager.map.set('sid', { tmux: 'cx_worker', socket: 'preview' });
  let stopped = false;
  manager.suspend = async () => { stopped = true; };
  manager._tmux = async () => {
    if (stopped) throw Object.assign(new Error('Command failed: tmux list-panes'), {
      code: 1, stderr: "can't find window: cx_worker\n",
    });
    return { stdout: '0\n' };
  };
  const store = new JobStore(path.join(DATA_DIR, 'receipt-teardown-jobs.json'));
  const job = store.create({ title: 'Inspect repositories', intent: 'Plan the rename', agent: 'codex' });
  store.action(job.id, 'start');
  const run = store.claim(job.id, null, 'planning');
  store.bindRun(job.id, run.id, 'sid');
  store.report('sid', run.id, { kind: 'blocked', summary: 'Repository access needs restoring.' });
  const report = store.get(job.id).runs[0].report;
  const runner = new JobRunner({ store, runtime: new JobRuntime({ sessionManager: manager, taskStore: { taskFor: () => null } }) });
  await runner.tick();
  assert.equal(stopped, true);
  assert.equal(store.get(job.id).runs[0].stopped, true);
  assert.deepEqual(store.get(job.id).runs[0].report, report);
  assert.equal(store.get(job.id).error, 'Repository access needs restoring.');
  // A stopped run never resumes, so its card leaves the board rather than
  // lingering as dormant clutter for every phase of every sub-job.
  assert.equal(manager.isArchived('sid'), true);
});

test('archiving a stopped step never re-stamps an existing archive or resurrects a purged card', async () => {
  const manager = new SessionManager(); manager.map.clear(); manager._save = () => {};
  manager.map.set('sid', { tmux: 'cx_worker', socket: 'preview', archivedAt: 5 });
  manager.suspend = async () => {};
  manager._tmux = async () => { throw Object.assign(new Error('gone'), { code: 1, stderr: "can't find session: cx_worker" }); };
  const runtime = new JobRuntime({ sessionManager: manager, taskStore: { taskFor: () => null } });
  // The cleanup sweep re-runs stop() over runs settle already archived: keeping
  // the original stamp is what makes Search's buckets say when the step stopped.
  await runtime.stop({ sessionId: 'sid' });
  assert.equal(manager.entryFor('sid').archivedAt, 5);
  // A human purged the card mid-run; archive() would otherwise adopt the id back
  // into the mapping as an empty archived row.
  await runtime.stop({ sessionId: 'purged' });
  assert.equal(manager.entryFor('purged'), undefined);
});

test('job teardown retains its concurrency slot when the worker survives suspend', async () => {
  const manager = new SessionManager(); manager.map.clear();
  manager.map.set('sid', { tmux: 'cx_worker', socket: 'preview' });
  manager.suspend = async () => {};
  manager._tmux = async () => ({ stdout: '0\n' });
  const runtime = new JobRuntime({ sessionManager: manager });
  await assert.rejects(runtime.stop({ sessionId: 'sid' }), /still running/);
});

test('runtime fetches and selects the remote default branch before worktree launch', async () => {
  const calls = []; let launched, prepared;
  const runtime = new JobRuntime({ sessionManager: { async dispatch(opts) { launched = opts; opts.onAutomationPrepared('sid', { path: '/wt', branch: 'feature', repoRoot: '/repo' }); return { sessionId: 'sid' }; } }, memoryStore: { bindSession() {} }, taskStore: {} },
    async (bin, args) => { calls.push([bin, ...args]); return bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'trunk' } }) : 'base-sha'; });
  await runtime.launch(job, sub, run, (...v) => { prepared = v; });
  assert.deepEqual(calls[0], ['git', 'fetch', 'origin']); assert.equal(launched.worktreeBase, 'refs/remotes/origin/trunk');
  assert.equal(launched.worktree, true); assert.equal(launched.worktreeAuto, true); assert.equal(prepared[1].cleanupHead, 'base-sha');
  assert.deepEqual(launched.automationRun, { jobId: job.id, subJobId: sub.id, runId: run.id });
});

test('runtime refuses a missing worktree instead of recreating it on the base checkout', async () => {
  const runtime = new JobRuntime({ sessionManager: { dispatch() { assert.fail('must not dispatch'); } } });
  await assert.rejects(runtime.launch(job, { ...sub, worktree: { path: path.join(DATA_DIR, 'missing') } }, run, () => {}), /missing/);
});

test('every Codex job phase grants the existing workspace shared Git metadata, without granting its main checkout', async () => {
  const repo = path.join(DATA_DIR, 'publish-workspace');
  const metadata = path.join(DATA_DIR, 'main-checkout', '.git');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  execFileSync('git', ['init', '-q', '--separate-git-dir', metadata, repo], { stdio: 'pipe' });
  let launched;
  const runtime = new JobRuntime({ sessionManager: { async dispatch(opts) { launched = opts; return { sessionId: 'sid' }; } }, memoryStore: {}, taskStore: {} },
    async () => assert.fail('reuse the existing worktree without fetching or creating another'));
  for (const phase of ['implementation', 'publish', 'repair', 'verify']) {
    await runtime.launch({ ...job, agent: 'codex' }, { ...sub, repo: path.dirname(metadata), worktree: { path: repo } }, { ...run, phase }, () => {});
    assert.equal(launched.cwd, repo);
    assert.equal(launched.worktree, false);
    assert.deepEqual(launched.addDirs, [fs.realpathSync(metadata)]);
  }
});

test('planning launches without fetching or branching even when repository hints are supplied', async () => {
  for (const repos of [[], ['/missing-hint']]) {
    let launched, prepared;
    const runtime = new JobRuntime({ sessionManager: { async dispatch(opts) { launched = opts; opts.onAutomationPrepared('sid'); return { sessionId: 'sid' }; } }, memoryStore: { bindSession() {} }, taskStore: {} },
      async () => assert.fail('planning must not require git or gh before discovery'));
    await runtime.launch({ ...job, repos }, null, { ...run, phase: 'planning' }, (...v) => { prepared = v; });
    assert.equal(launched.cwd, ''); assert.equal(launched.worktree, false);
    assert.deepEqual(launched.addDirs, [path.join(os.homedir(), 'IdeaProjects')]);
    assert.deepEqual(prepared, ['sid', undefined]);
  }
});

test('cleanup refuses extra commits and deletes only the observed ref value', async () => {
  const calls = [], wt = { path: path.join(DATA_DIR, 'already-removed'), repoRoot: '/repo', branch: 'job-api' };
  const runtime = new JobRuntime({}, async (_bin, args) => { calls.push(args); return args[0] === 'for-each-ref' ? 'verified' : ''; });
  await runtime.cleanupWorktree(wt, 'verified'); assert.deepEqual(calls.at(-1), ['update-ref', '-d', 'refs/heads/job-api', 'verified']);
  calls.length = 0; await assert.rejects(runtime.cleanupWorktree(wt, 'older'), /additional commits/);
  assert.ok(!calls.some((c) => c[0] === 'update-ref'));
});

test('cleanup refuses a branch still checked out in another worktree', async () => {
  const runtime = new JobRuntime({}, async () => 'worktree /elsewhere\nbranch refs/heads/job-api');
  await assert.rejects(runtime.cleanupWorktree({ path: path.join(DATA_DIR, 'missing'), repoRoot: '/repo', branch: 'job-api' }, 'verified'), /another worktree/);
});

test('repository-free planning gets a scratch workspace and durable report assignment before process start', async () => {
  const manager = new SessionManager(); manager.map.clear(); manager._save = () => {}; manager.refreshAlive = async () => {};
  let bound = false, savedAtLaunch;
  manager._newSession = async () => { assert.equal(bound, true); savedAtLaunch = [...manager.map.values()][0]; assert.equal(savedAtLaunch.automationRun.runId, 'run1'); };
  const runtime = new JobRuntime({ sessionManager: manager, memoryStore: { bindSession() {} }, taskStore: {} }, async () => assert.fail('planning must not fetch'));
  const { sessionId } = await runtime.launch({ ...job, repos: [] }, null, { id: 'run1', phase: 'planning' }, (sid) => { bound = true; assert.ok(manager.entryFor(sid)); });
  const entry = manager.entryFor(sessionId);
  assert.equal(path.dirname(entry.cwd), SESSIONS_DIR); assert.ok(fs.existsSync(entry.cwd));
  assert.equal(entry.worktree, undefined);
  assert.equal(entry.autoFixPrChecks, false); assert.equal(entry.autoMergeOnPass, false);
  assert.deepEqual(resumeEntry(entry, { now: 1 }).automationRun, { jobId: job.id, subJobId: null, runId: 'run1' });
  let review = false; manager._archiveReview = async () => { review = true; };
  manager.archive(sessionId); assert.equal(review, false);
});

test('prompts keep reports mandatory, retain previous Jira context and prohibit agent polling', () => {
  const text = jobPrompt({ ...job, plan: null, previousPlan: { stories: [{ key: 'AUTH-1' }] }, feedback: 'Split by repo' }, null, { ...run, phase: 'planning' });
  assert.match(text, /AUTH-1/); assert.match(text, /Split by repo/); assert.match(text, /job_report/); assert.match(text, /Do not spawn/);
  assert.match(jobPrompt(job, sub, { ...run, phase: 'publish' }), /Do not merge or wait for CI/);
});

test('deployed verification is kept off production data', () => {
  const verify = jobPrompt(job, { ...sub, pr: { mergeCommit: 'abc123' }, deployment: { verify: 'Expired links rejected' } }, { ...run, phase: 'verify' });
  assert.match(verify, /Never modify production data/);
  assert.match(verify, /playground deployment if one exists, otherwise dev/);
  assert.match(verify, /report blocked instead/);
});

test('PR-only validation is assigned after publication and retained in the publishing handoff', () => {
  assert.match(jobPrompt(job, null, { ...run, phase: 'planning' }), /Never require a PR-triggered check before the PR exists/);
  const implementation = jobPrompt(job, sub, run);
  assert.match(implementation, /pendingChecks/);
  assert.match(implementation, /essential local verification blocked by missing access still requires a blocked receipt/);
  const pendingChecks = ['Dev/prod plans: no replacement or credential rotation'];
  const publish = jobPrompt(job, { ...sub, local: { pendingChecks } }, { ...run, phase: 'publish' });
  assert.match(publish, /Required PR checks still pending/);
  assert.ok(publish.includes(pendingChecks[0]));
  assert.match(publish, /Confirm the PR workflows cover them/);
});

test('cleanup of a cancelled sub-job keeps unpushed commits and never fast-forwards main', async () => {
  const calls = [], archived = [], wt = { path: path.join(DATA_DIR, 'cancelled-gone'), repoRoot: '/repo', branch: 'job-api', cleanupHead: 'base' };
  const runtime = new JobRuntime({ sessionManager: { async suspend() {}, entryFor: () => ({}), isArchived: () => false, archive(sid) { archived.push(sid); } }, taskStore: { taskFor() { return null; } } },
    async (_bin, args) => { calls.push(args); return args[0] === 'for-each-ref' ? 'base' : ''; });
  await runtime.cleanup({ updateMain: true }, { ...sub, cancelledAt: 1, sessions: ['sid'], worktree: wt, pr: null });
  assert.deepEqual(archived, ['sid']);
  assert.deepEqual(calls.at(-1), ['update-ref', '-d', 'refs/heads/job-api', 'base']);
  assert.ok(!calls.some((c) => c[0] === 'merge'), 'nothing merged, so main is left alone');
  const committed = new JobRuntime({}, async (_bin, args) => args[0] === 'for-each-ref' ? 'unpushed' : '');
  await assert.rejects(committed.cleanup({}, { ...sub, cancelledAt: 1, sessions: [], worktree: wt, pr: null }), /additional commits/);
});
