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

test('runtime always branches on the placeholder; a plan-time branch name is ignored, the implementer renames', async () => {
  const branches = [];
  const runtime = new JobRuntime({ sessionManager: { async dispatch(opts) { branches.push(opts.worktreeBranch); opts.onAutomationPrepared('sid', { path: '/wt', branch: opts.worktreeBranch, repoRoot: '/repo' }); return { sessionId: 'sid' }; } }, memoryStore: { bindSession() {} }, taskStore: {} },
    async (bin) => bin === 'gh' ? JSON.stringify({ defaultBranchRef: { name: 'main' } }) : 'sha');
  await runtime.launch(job, { ...sub, branch: 'fix/AUTH-1-deliver-api' }, run, () => {});
  await runtime.launch(job, sub, run, () => {});
  assert.deepEqual(branches, ['job-12345678-api', 'job-12345678-api']);
});

test('the implementer is told to name its placeholder branch in the repo\'s convention via name_branch, and to keep a name it already gave', () => {
  const fresh = jobPrompt(job, { ...sub, worktree: { branch: 'job-12345678-api' } }, run);
  assert.match(fresh, /job-12345678-api\) is a placeholder/); assert.match(fresh, /branch-naming convention/); assert.match(fresh, /Jira key is AUTH-1/);
  assert.match(fresh, /name_branch MCP tool \(never git branch -m\)/);
  assert.match(jobPrompt(job, sub, run), /is a placeholder/, 'a sub-job whose worktree is not yet recorded is still told to rename');
  const named = jobPrompt(job, { ...sub, worktree: { branch: 'fix/AUTH-1-deliver-api' } }, { ...run, phase: 'publish' });
  assert.match(named, /branch is fix\/AUTH-1-deliver-api; keep it/); assert.doesNotMatch(named, /is a placeholder/);
  assert.match(jobPrompt(job, { ...sub, worktree: { branch: 'job-12345678-api' } }, { ...run, phase: 'publish' }), /is a placeholder/, 'publish repeats it: that is where the name reaches origin');
  assert.doesNotMatch(jobPrompt(job, null, { ...run, phase: 'planning' }), /For every PR sub-job propose branch|{key}/);
  assert.match(jobPrompt(job, null, { ...run, phase: 'planning' }), /Do not propose branch names/);
});

test('runtime refuses a missing worktree instead of recreating it on the base checkout', async () => {
  const runtime = new JobRuntime({ sessionManager: { dispatch() { assert.fail('must not dispatch'); } } });
  await assert.rejects(runtime.launch(job, { ...sub, worktree: { path: path.join(DATA_DIR, 'missing') } }, run, () => {}), /missing/);
});

test('every run after the first adopts the sub-job worktree, and leaves the store\'s copy of it alone', async () => {
  const dir = path.join(DATA_DIR, 'adopted-workspace');
  fs.mkdirSync(dir, { recursive: true });
  const wt = { path: dir, branch: 'job-12345678-api', repoRoot: '/repo', cleanupHead: 'base-sha' };
  let launched, prepared;
  const runtime = new JobRuntime({ sessionManager: { async dispatch(opts) { launched = opts; opts.onAutomationPrepared('sid', opts.worktreeAdopt); return { sessionId: 'sid' }; } }, memoryStore: { bindSession() {} }, taskStore: { assign() {} } },
    async () => assert.fail('reuse the existing worktree without fetching or creating another'));
  for (const phase of ['implementation', 'publish', 'repair', 'verify']) {
    prepared = 'unset';
    await runtime.launch(job, { ...sub, worktree: wt }, { ...run, phase }, (...v) => { prepared = v; });
    assert.equal(launched.worktree, false);
    assert.deepEqual(launched.worktreeAdopt, wt, 'the entry is stamped with it, so name_branch works on this run too');
    assert.deepEqual(prepared, ['sid', undefined], "only the creating run reports it: cleanupHead and any rename stay the store's");
  }
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

// The job the prompts are written against: one shared context, briefs that lean
// on it, and a second sub-job so the "After" line has something to name.
const planned = {
  ...job,
  plan: { context: 'The sign-in service is Java; deploys are Helm.', stories: [{ id: 'story', key: 'AUTH-1', title: 'Sign-in' }], subJobs: [] },
  subJobs: [{ id: 'proto', title: 'Sync the proto', kind: 'pr' }],
};
const briefed = { ...sub, title: 'Deliver api', brief: 'Retry the token exchange once', after: ['proto'], worktree: { branch: 'fix/AUTH-1-api' } };

test('every phase ends with its own receipt call, naming this run and the blocked shape', () => {
  for (const phase of ['planning', 'jira', 'implementation', 'repair', 'verify', 'session']) {
    const text = jobPrompt(planned, { ...briefed, pr: { url: 'https://github.com/org/repo/pull/1', mergeCommit: 'abc123' }, check: 'Sign-in works in dev' }, { ...run, phase });
    assert.match(text, /job_report \{runId:"run1"/, phase);
    assert.match(text, /Blocked: \{kind:"blocked", summary:"one sentence", move\?:"fix-here"/, phase);
  }
});

test('the implementation prompt is one bounded step: context once, the brief, what it lands after, and the human\'s note', () => {
  const text = jobPrompt(planned, { ...briefed, check: 'Sign-in works in dev', note: 'Call the flag sign_in_v2' }, run);
  assert.match(text, /^AUTH-1 · Sign-in$/m);
  assert.match(text, /Context: The sign-in service is Java/);
  assert.match(text, /This PR \(repo\): Retry the token exchange once/);
  assert.match(text, /Check after it lands: Sign-in works in dev/);
  assert.match(text, /After: Sync the proto\./);
  assert.match(text, /Note from the human: Call the flag sign_in_v2/);
  assert.match(text, /Commit, push, open the PR, then job_report \{runId:"run1", kind:"published", url:"<PR url>"\}/);
  const plainest = jobPrompt(planned, { ...briefed, after: [] }, run);
  assert.match(plainest, /After: none\./);
  assert.doesNotMatch(plainest, /Check after it lands|Note from the human/, 'nothing to say is nothing written');
});

test('a repair carries the human\'s note when there is one, and the checks otherwise', () => {
  const pr = { url: 'https://github.com/org/repo/pull/7' };
  const asked = jobPrompt(planned, { ...briefed, pr, fixRequested: { note: 'Rename the flag' } }, { ...run, phase: 'repair' });
  assert.match(asked, /Fix PR https:\/\/github.com\/org\/repo\/pull\/7 on this worktree branch: the human asks: Rename the flag/);
  const failing = jobPrompt(planned, { ...briefed, pr }, { ...run, phase: 'repair' });
  assert.match(failing, /failing checks, merge conflicts or requested changes/);
  for (const text of [asked, failing]) assert.match(text, /Never weaken checks; never merge/);
});

test('a verify session exists only for the plan\'s one check, and stays off production data', () => {
  const verify = jobPrompt(planned, { ...briefed, check: 'Expired links are rejected', pr: { url: 'u', mergeCommit: 'abc123' },
    deploymentResult: { runs: [{ workflow: 'Deploy', status: 'passing' }, { workflow: 'Scan', status: 'skipped' }] } }, { ...run, phase: 'verify' });
  assert.match(verify, /merged as abc123; post-merge runs passed \(Deploy\)/);
  assert.match(verify, /Confirm: Expired links are rejected/);
  assert.match(verify, /Never modify production data/);
  assert.match(verify, /playground or dev/);
  assert.match(verify, /Do not change the deployment/);
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

test('a session step launches in a scratch workspace like planning and its cleanup never touches git', async () => {
  let launched, prepared;
  const runtime = new JobRuntime({ sessionManager: { async dispatch(opts) { launched = opts; opts.onAutomationPrepared('sid'); return { sessionId: 'sid' }; } }, memoryStore: { bindSession() {} }, taskStore: {} },
    async () => assert.fail('a session sub-job has no repository to fetch'));
  const session = { id: 'spike', kind: 'session', jiraKey: 'AUTH-1', brief: 'Investigate', after: [] };
  await runtime.launch(job, session, { ...run, phase: 'session' }, (...v) => { prepared = v; });
  assert.equal(launched.cwd, ''); assert.equal(launched.worktree, false);
  assert.deepEqual(launched.addDirs, [path.join(os.homedir(), 'IdeaProjects')]);
  assert.deepEqual(prepared, ['sid', undefined]);
  const archived = [];
  const cleaner = new JobRuntime({ sessionManager: { async suspend() {}, entryFor: () => ({}), isArchived: () => false, archive(sid) { archived.push(sid); } }, taskStore: { taskFor() { return null; } } },
    async () => assert.fail('nothing to fast-forward or remove'));
  await cleaner.cleanup({ updateMain: true }, { ...session, sessions: ['sid'], pr: null, worktree: undefined });
  assert.deepEqual(archived, ['sid']);
});

test('the session prompt keeps its step out of every repository and carries a review\'s feedback', () => {
  const text = jobPrompt({ ...planned, subJobs: [{ id: 'spike', kind: 'session', title: 'Spike the schema' }] },
    { id: 'backfill', kind: 'session', jiraKey: 'AUTH-1', brief: 'Backfill the audit rows', after: ['spike'], feedback: 'Also check staging' },
    { ...run, phase: 'session' });
  assert.match(text, /This session: Backfill the audit rows/);
  assert.match(text, /After: Spike the schema\./);
  assert.match(text, /no repository changes \(report blocked if one is needed\)/);
  assert.match(text, /Feedback on your previous attempt: Also check staging/);
  assert.match(text, /kind:"completed"/);
});

test('the planner is told to write the context once and never to describe a deployment', () => {
  const text = jobPrompt({ ...planned, plan: null, previousPlan: { stories: [{ key: 'AUTH-1' }] }, feedback: 'Split by repo' }, null, { ...run, phase: 'planning' });
  assert.match(text, /AUTH-1/); assert.match(text, /Split by repo/);
  assert.match(text, /Write `context` ONCE for the whole job/);
  assert.match(text, /Never describe deployments or verification steps/);
  assert.match(text, /`after` on a PR means DEPLOY AFTER/);
  assert.match(text, /Do not propose branch names/);
  assert.match(text, /kind:"pr"\|"session"/);
  assert.match(text, /kind:"plan", plan:\{context, stories:\[\{id,key\?,project\?,title\}\]/);
  assert.doesNotMatch(text, /deployment:\{|pendingChecks|value/);
  assert.ok(text.split(/\s+/).length < 400, 'the protocol lives in the job-worker skill, not in every prompt');
});

test('the ticketing prompt creates exactly the approved titles', () => {
  const text = jobPrompt(planned, null, { ...run, phase: 'jira' });
  assert.match(text, /"key":"AUTH-1"/);
  assert.match(text, /Search first so a retry never duplicates one/);
  assert.match(text, /kind:"jira", stories:\[\{id,key\}\]/);
});

const dialog = (cursorOnYes) => `
 Quick safety check: Is this a project you created or one you trust?
 ${cursorOnYes ? '  ' : '❯ '}No, exit
 ${cursorOnYes ? '❯ ' : '  '}Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;
const paneHarness = (screens) => {
  const manager = new SessionManager(); manager.map.clear();
  manager.map.set('sid', { tmux: 'cc_worker', socket: 'preview', cwd: '/repo-worktree-x' });
  const runtime = new JobRuntime({ sessionManager: manager });
  const sent = [];
  runtime._pane = {
    capture: async (name, _lines, socket) => { assert.equal(name, 'cc_worker'); assert.equal(socket, 'preview'); return screens.shift() ?? ''; },
    sendKeys: async (name, keys, socket) => { assert.equal(name, 'cc_worker'); assert.equal(socket, 'preview'); sent.push(keys.join(' ')); },
  };
  return { runtime, sent };
};

test('acceptTrustDialog moves the cursor off the "No, exit" default and confirms it landed before pressing Enter', async () => {
  const { runtime, sent } = paneHarness([dialog(false), dialog(true)]);
  assert.equal(await runtime.acceptTrustDialog({ sessionId: 'sid' }), true);
  assert.deepEqual(sent, ['Down', 'Enter']);
});

test('acceptTrustDialog presses only Enter when a human already moved the cursor to Yes', async () => {
  const { runtime, sent } = paneHarness([dialog(true)]);
  assert.equal(await runtime.acceptTrustDialog({ sessionId: 'sid' }), true);
  assert.deepEqual(sent, ['Enter']);
});

test('acceptTrustDialog never sends Enter blind: no dialog, a vanished dialog, or a cursor that did not move', async () => {
  let h = paneHarness(['❯ Try "fix typecheck errors"']);
  assert.equal(await h.runtime.acceptTrustDialog({ sessionId: 'sid' }), false);
  assert.deepEqual(h.sent, []);
  h = paneHarness([dialog(false), '❯ Try "fix typecheck errors"']);
  assert.equal(await h.runtime.acceptTrustDialog({ sessionId: 'sid' }), false);
  assert.deepEqual(h.sent, ['Down'], 'the dialog was answered elsewhere between reads — Enter would land in the composer');
  h = paneHarness([dialog(false), dialog(false)]);
  assert.equal(await h.runtime.acceptTrustDialog({ sessionId: 'sid' }), false);
  assert.deepEqual(h.sent, ['Down'], 'Enter on an unmoved cursor would select "No, exit"');
  h = paneHarness([]);
  assert.equal(await h.runtime.acceptTrustDialog({ sessionId: 'missing' }), false, 'no mapping, no pane to read');
});

test('the runner answers the dialog for a live, unreported run and keeps the run open', async () => {
  const { runtime, sent } = paneHarness([dialog(false), dialog(true)]);
  runtime.isAlive = async () => true;
  const store = new JobStore(path.join(DATA_DIR, 'trust-dialog-jobs.json'));
  const job = store.create({ title: 'Bulk import', intent: 'Import users', agent: 'claude' });
  store.action(job.id, 'start');
  const run = store.claim(job.id, null, 'planning');
  store.bindRun(job.id, run.id, 'sid');
  const runner = new JobRunner({ store, runtime });
  await runner.tick();
  assert.deepEqual(sent, ['Down', 'Enter']);
  assert.equal(store.get(job.id).runs[0].stopped, false);
  assert.equal(store.get(job.id).error, undefined);
  runtime.acceptTrustDialog = async () => { throw new Error('tmux blipped'); };
  await runner.tick();
  assert.equal(store.get(job.id).runs[0].stopped, false, 'a failed dialog probe never fails the run');
  assert.equal(store.get(job.id).error, undefined);
});
