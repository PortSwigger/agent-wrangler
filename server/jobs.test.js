import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './job-store.js';
import { JobRunner } from './job-runner.js';
import { JobGithub, prSummary } from './job-github.js';
import { normaliseComments, commentsBlockMerge } from './job-comments.js';
import { jobReportTool, getJobContextTool } from './mcp/tools/job-report.js';
import { allowedToolsArg } from './mcp/client-config.js';
import { routeControlMessage } from './control/router.js';

const input = { title: 'Reliable sign-in', intent: 'Customers can sign in reliably', repos: ['/repo'], reviewCode: true, reviewMerge: true };
const spec = (id, dependsOn = []) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', dependsOn,
  instructions: `Implement ${id}`, deployment: { verify: 'Check running version and sign-in' } });
const plan = (subs = [spec('api')]) => ({ stories: [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in', value: 'Customers can access their account' }], subJobs: subs });
function fixture(t, jobInput = input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JobStore(path.join(dir, 'jobs.json'));
  const launched = [], stopped = [], merged = [], cleaned = [], alive = new Set();
  let clock = Date.now();
  const runtime = {
    async launch(j, s, r, prepared) {
      const sid = `session-${r.id}`; alive.add(sid); launched.push({ job: j, sub: s, run: r, sid });
      prepared(sid, s?.worktree ? undefined : { path: `/worktree/${s?.id || r.id}`, repoRoot: '/repo', branch: `branch-${s?.id || r.id}` });
    },
    async stop(r) { stopped.push(r.id); alive.delete(r.sessionId); },
    async isAlive(r) { return alive.has(r.sessionId); },
    async cleanup(j, s) { cleaned.push(s.id); }, async cleanupPlanning() {},
    attributeSpend(s, live) { attributed.push(live); },
  };
  let pr = { state: 'OPEN', checkStatus: 'pending', head: 'head1', mergeCommit: null, checks: [], base: 'main' };
  let deployment = { status: 'pending', runs: [], commit: 'merge1' };
  let comments = normaliseComments(resource(), 0);
  const attributed = [], triaged = [];
  let verdict = async () => ({ tone: 'green', text: 'Reviewer approved.', liveSessionId: 'live-triage', error: false });
  const github = { async pr(s) { return { ...pr, url: s.pr.url }; }, async comments() { return comments; }, async merge(s) { merged.push(s.pr.head); }, async deployment() { return deployment; } };
  const runner = new JobRunner({ store, runtime, github, now: () => clock, summarise: async (c, p) => { triaged.push(c.fingerprint); return verdict(c, p); } });
  const createInput = jobInput;
  const job = store.create(createInput);
  const tick = async () => { clock += 61000; await runner.tick(); };
  const last = () => launched.at(-1);
  const report = (payload, worker = last()) => store.report(worker.sid, worker.run.id, payload);
  async function approve(p = plan()) {
    store.action(job.id, 'start'); await tick(); report({ kind: 'plan', plan: p }); await tick();
    const current = store.get(job.id); store.approvePlan(job.id, current.revision); await tick();
  }
  return { store, job, runner, runtime, github, alive, launched, stopped, merged, cleaned, tick, last, report, approve, attributed, triaged,
    setPr: (value) => { pr = { ...pr, ...value }; }, setDeployment: (value) => { deployment = value; },
    setComments: (value) => { comments = normaliseComments(value, 0); }, setVerdict: (fn) => { verdict = fn; } };
}
const author = (login, bot = false) => ({ login, __typename: bot ? 'Bot' : 'User' });
const node = (id, login, body, at, extra = {}) => ({ id, author: author(login, extra.bot), body, createdAt: at, updatedAt: at, url: `https://github.com/org/repo/pull/1#${id}`, ...extra });
// A GraphQL `resource` payload in the shape COMMENTS_QUERY returns.
function resource({ comments = [], reviews = [], threads = [] } = {}) {
  return { author: { login: 'agent' }, comments: { nodes: comments }, reviews: { nodes: reviews },
    reviewThreads: { nodes: threads.map((t) => ({ id: t.id, isResolved: !!t.resolved, isOutdated: false, path: t.path || 'src/app.js', line: 4, comments: { nodes: t.comments } })) } };
}

test('store persists settings, plans and live claims across restart', async (t) => {
  const f = fixture(t); await f.approve();
  f.store.settings({ concurrency: 4 });
  assert.deepEqual(new JobStore(f.store.file).snapshot(), f.store.snapshot());
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1);
});

test('invalid cycles, missing Jira value and ambiguous repository paths cannot reach approval', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const before = f.store.snapshot();
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', ['b']), spec('b', ['a'])]) }), /cycles/);
  assert.throws(() => f.report({ kind: 'plan', plan: { ...plan(), stories: [{ id: 'story', key: 'AUTH-123', title: 'x', value: '' }] } }));
  for (const repo of ['service', 'https://github.com/org/repo', '/repo\n/other']) {
    assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), repo }]) }), /local repository path/);
  }
  assert.deepEqual(f.store.snapshot(), before);
});

test('jobs without repository hints discover and persist repositories before human approval', async (t) => {
  const { repos, ...withoutRepos } = input;
  const f = fixture(t, withoutRepos);
  assert.deepEqual(f.job.repos, []);
  assert.deepEqual(f.store.create({ ...input, repos: [] }).repos, []);
  f.store.action(f.job.id, 'start'); await f.tick();
  const proposed = plan([spec('api'), { ...spec('web'), repo: '/web' }, spec('api-followup', ['api'])]);
  f.report({ kind: 'plan', plan: proposed }); await f.tick();
  const current = new JobStore(f.store.file).get(f.job.id);
  assert.deepEqual(current.repos, ['/repo', '/web']);
  assert.equal(current.stage, 'planning'); assert.deepEqual(current.subJobs, []);
  assert.equal(f.launched.length, 1, 'discovery must wait for plan approval');
  f.store.approvePlan(f.job.id, current.revision); await f.tick();
  assert.deepEqual(f.launched.slice(1).map((w) => w.sub.repo), ['/repo', '/web']);
});

test('repository hints allow discovery beyond them and refinements replace the proposed repositories', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([{ ...spec('api'), repo: '/discovered' }]) }); await f.tick();
  const first = f.store.get(f.job.id);
  assert.deepEqual(first.repos, ['/discovered']);
  f.store.action(f.job.id, 'replan', { feedback: 'Move this change to the shared service' }); await f.tick();
  assert.deepEqual(f.last().job.previousPlan, first.plan);
  f.report({ kind: 'plan', plan: plan([{ ...spec('api'), repo: '/shared' }]) }); await f.tick();
  assert.deepEqual(f.store.get(f.job.id).repos, ['/shared']);
  assert.throws(() => f.store.approvePlan(f.job.id, first.revision), /changed/);
  const latest = f.store.get(f.job.id);
  const edited = plan([{ ...spec('api'), repo: '/reviewed' }]);
  f.store.approvePlan(f.job.id, latest.revision, edited);
  assert.deepEqual(f.store.get(f.job.id).repos, ['/reviewed']);
  assert.equal(f.store.get(f.job.id).subJobs[0].repo, '/reviewed');
});

test('reports require the assigned caller, expected phase and short factual checks', async (t) => {
  const f = fixture(t); await f.approve();
  const w = f.last();
  assert.throws(() => f.store.report('someone-else', w.run.id, { kind: 'local', commitMessage: 'AUTH-123: sign-in', checks: ['Tests pass'] }), /assigned/);
  assert.throws(() => f.report({ kind: 'deployed', checks: ['Works'] }), /must submit local/);
  assert.throws(() => f.report({ kind: 'local', commitMessage: 'Wrong ticket', checks: ['Tests pass'] }), /Jira/);
  assert.throws(() => f.report({ kind: 'local', commitMessage: 'AUTH-123: sign-in', checks: ['a'.repeat(181)] }));
  assert.throws(() => f.report({ kind: 'local', commitMessage: 'AUTH-123: sign-in', checks: [] }));
  f.report({ kind: 'local', commitMessage: 'AUTH-123: sign-in', checks: ['Tests pass'] });
  await f.tick();
  f.report({ kind: 'local', commitMessage: 'AUTH-123: sign-in', checks: ['Tests pass'] }, w);
  assert.throws(() => f.report({ kind: 'local', commitMessage: 'AUTH-123: changed', checks: ['Tests pass'] }, w), /different report/);
});

test('PR-only checks persist separately from local evidence and publication still waits on review and CI', async (t) => {
  const f = fixture(t); await f.approve();
  const pendingChecks = ['Dev/prod Terraform plans preserve client IDs and credentials'];
  f.report({ kind: 'local', commitMessage: 'AUTH-123: Rename display names', checks: ['Terraform tests pass'], pendingChecks });
  await f.tick();
  const sub = new JobStore(f.store.file).get(f.job.id).subJobs[0];
  assert.deepEqual(sub.local.checks, ['Terraform tests pass']);
  assert.deepEqual(sub.local.pendingChecks, pendingChecks);
  assert.equal(f.last().run.phase, 'implementation', 'keep the code review gate');
  f.store.action(f.job.id, 'approve-code', { subJobId: sub.id, localReceiptId: sub.local.receiptId });
  await f.tick();
  assert.equal(f.last().run.phase, 'publish');
  assert.deepEqual(f.last().sub.local.pendingChecks, pendingChecks);
  f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/1' });
  await f.tick();
  assert.equal(f.merged.length, 0);
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: sub.id, head: 'head1' }), /green/);
});

test('retrying a blocked publisher preserves code approval, receipt and worktree', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'local', commitMessage: 'AUTH-123: sign-in', checks: ['Tests pass'] });
  await f.tick();
  const local = f.store.get(f.job.id).subJobs[0].local;
  f.store.action(f.job.id, 'approve-code', { subJobId: 'api', localReceiptId: local.receiptId });
  await f.tick();
  const approved = f.store.get(f.job.id).subJobs[0];
  assert.equal(f.last().run.phase, 'publish');
  f.report({ kind: 'blocked', summary: 'Git metadata needs write access' });
  await f.tick();
  f.store.action(f.job.id, 'retry', { subJobId: 'api' });
  await f.tick();
  const retried = f.store.get(f.job.id).subJobs[0];
  assert.equal(f.last().run.phase, 'publish');
  assert.deepEqual(retried.local, local);
  assert.equal(retried.codeApprovedAt, approved.codeApprovedAt);
  assert.deepEqual(retried.worktree, approved.worktree);
  assert.equal(f.launched.filter(w => w.run.phase === 'implementation').length, 1);
});

test('plan approval is explicit and rejects a stale or running review', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan() });
  assert.throws(() => f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision), /not ready/);
  await f.tick();
  assert.equal(f.launched.length, 1);
  const rev = f.store.get(f.job.id).revision;
  f.store.action(f.job.id, 'pause');
  assert.throws(() => f.store.approvePlan(f.job.id, rev), /changed/);
});

test('complete lifecycle: short receipts, optional local review, head-bound merge and verified cleanup', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'local', commitMessage: 'AUTH-123: reliable sign-in', checks: ['Tests pass', 'Running API curl passes'] });
  await f.tick(); assert.equal(f.last().run.phase, 'implementation');
  let sub = f.store.get(f.job.id).subJobs[0];
  f.store.action(f.job.id, 'approve-code', { subJobId: sub.id, localReceiptId: sub.local.receiptId });
  await f.tick(); assert.equal(f.last().run.phase, 'publish');
  f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/1' });
  f.setPr({ checkStatus: 'passing' }); await f.tick(); assert.equal(f.merged.length, 0);
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'older' }), /green/);
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
  f.setPr({ head: 'head2' }); await f.tick(); assert.equal(f.merged.length, 0);
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head2' });
  await f.tick(); await f.tick(); assert.deepEqual(f.merged, ['head2']);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.store.get(f.job.id).subJobs[0].stage, 'deployment');
  await f.tick(); assert.equal(f.last().run.phase, 'publish');
  f.setDeployment({ status: 'passing', runs: [{ workflow: 'deploy.yml', status: 'passing' }], commit: 'merge1' });
  await f.tick(); assert.equal(f.last().run.phase, 'verify');
  f.report({ kind: 'deployed', checks: ['Running version is merge1', 'Sign-in works against deployed API'] });
  await f.tick(); assert.equal(f.store.get(f.job.id).stage, 'done'); assert.deepEqual(f.cleaned, ['api']);
});

test('concurrency applies to all jobs and paused work never starts a session', async (t) => {
  const f = fixture(t); f.store.settings({ concurrency: 1 });
  const second = f.store.create(input); f.store.action(f.job.id, 'start'); f.store.action(second.id, 'start');
  await f.tick(); await f.tick(); assert.equal(f.launched.length, 1);
  f.store.settings({ paused: true }); f.report({ kind: 'plan', plan: plan() }); await f.tick();
  assert.equal(f.launched.length, 1); assert.equal(f.alive.size, 0);
  f.store.settings({ paused: false }); await f.tick(); assert.equal(f.launched.length, 2);
});

test('dependent sub-jobs build in parallel, then reverify once dependencies have deployed', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web', ['api'])]));
  const builds = f.launched.filter((w) => w.run.phase === 'implementation'); assert.equal(builds.length, 2);
  builds.forEach((w) => f.report({ kind: 'local', commitMessage: 'AUTH-123: change', checks: ['Tests pass'] }, w));
  await f.tick();
  let web = f.store.get(f.job.id).subJobs[1]; assert.equal(web.dependenciesVerified, false);
  assert.throws(() => f.store.action(f.job.id, 'approve-code', { subJobId: 'web', localReceiptId: web.local.receiptId }), /not ready/);
  f.store.update(f.job.id, (j) => { j.subJobs[0].deployed = { checks: ['Live'] }; j.subJobs[0].stage = 'done'; });
  await f.tick(); assert.equal(f.last().sub.id, 'web'); assert.equal(f.last().run.phase, 'implementation');
  f.report({ kind: 'local', commitMessage: 'AUTH-123: change', checks: ['Tests pass against deployed API'] }); await f.tick();
  web = f.store.get(f.job.id).subJobs[1]; assert.equal(web.dependenciesVerified, true); assert.equal(web.codeApprovedAt, null);
});

async function atPr(f) {
  f.store.update(f.job.id, (j) => { j.reviewCode = false; j.reviewMerge = false; });
  await f.approve(); f.report({ kind: 'local', commitMessage: 'AUTH-123: change', checks: ['Tests pass'] }); await f.tick();
  f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/1' });
}

test('failed CI wakes only bounded repair sessions and retains their short changes', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 1 }); await atPr(f);
  f.setPr({ checkStatus: 'failing' }); await f.tick(); assert.equal(f.last().run.phase, 'repair');
  await f.tick(); assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 1);
  f.report({ kind: 'repaired', changes: ['Fixed flaky clock assertion'], checks: ['Clock test passes'] }); await f.tick();
  const sub = f.store.get(f.job.id).subJobs[0]; assert.equal(sub.repairs.length, 1); assert.match(sub.error, /limit reached/);
  f.store.action(f.job.id, 'retry', { subJobId: sub.id }); await f.tick(); assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 2);
});

test('deployment failure creates exactly one manual recovery job and cleans up the merged sub-job', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'failing', runs: [{ workflow: 'deploy.yml', status: 'failing' }], commit: 'merge1' });
  await f.tick();
  const jobs = f.store.snapshot().jobs; assert.equal(jobs.length, 2); assert.equal(jobs[1].stage, 'backlog');
  assert.equal(jobs[1].runs.length, 0); assert.equal(jobs[1].recoveryOf.subJobId, 'api');
  const sub = jobs[0].subJobs[0];
  assert.equal(sub.stage, 'cleanup'); assert.equal(sub.error, null); assert.equal(sub.recoveryJobId, jobs[1].id);
  assert.match(sub.recoveryReason, /Deployment workflow failed/); assert.equal(sub.deployed, undefined);
  assert.equal(new JobStore(f.store.file).snapshot().jobs.length, 2);
  // The original job finishes without waiting on the recovery job, which stays in the backlog.
  await f.tick(); assert.deepEqual(f.cleaned, ['api']); assert.equal(f.store.get(f.job.id).stage, 'done');
  assert.equal(f.store.snapshot().jobs.length, 2); assert.equal(f.store.get(jobs[1].id).stage, 'backlog');
});

test('a sub-job parked in the old recovery state is released to cleanup on the next tick', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.store.update(f.job.id, (j) => { const s = j.subJobs[0]; s.recoveryJobId = 'job_old'; s.state = 'recovery'; s.error = 'Deployment workflow failed.'; });
  await f.tick();
  const sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.stage, 'cleanup'); assert.equal(sub.error, null); assert.equal(sub.recoveryReason, 'Deployment workflow failed.');
  await f.tick(); assert.deepEqual(f.cleaned, ['api']); assert.equal(f.store.get(f.job.id).stage, 'done');
});

test('a failed live behaviour check also proposes recovery and cleans up the merged sub-job', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'passing', runs: [], commit: 'merge1' }); await f.tick();
  f.report({ kind: 'blocked', summary: 'Deployed endpoint returns 500' }); await f.tick();
  assert.equal(f.store.snapshot().jobs.length, 2); assert.equal(f.launched.filter((l) => l.run.phase === 'verify').length, 1);
  const sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.stage, 'cleanup'); assert.equal(sub.recoveryReason, 'Deployed endpoint returns 500'); assert.equal(sub.deployed, undefined);
});

test('crashed and uncertain launches are blocked, not silently duplicated on restart', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick(); await f.tick();
  assert.match(f.store.get(f.job.id).subJobs[0].error, /without a verification receipt/);
  assert.equal(f.launched.length, 2);
  const other = f.store.create(input); f.store.action(other.id, 'start'); f.store.claim(other.id, null, 'planning');
  await f.tick(); assert.match(f.store.get(other.id).error, /Launch was interrupted/);
});

test('session teardown failure keeps its slot reserved', async (t) => {
  const f = fixture(t); await f.approve(); f.report({ kind: 'local', commitMessage: 'AUTH-123: change', checks: ['Tests pass'] });
  f.runtime.stop = async () => { throw new Error('Still alive'); }; await f.tick();
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1);
  assert.match(f.store.get(f.job.id).error, /Still alive/);
});

test('a failed liveness query does not stop the worker or release its slot', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.runtime.isAlive = async () => { throw new Error('tmux temporarily unavailable'); };
  await f.tick();
  assert.equal(f.stopped.length, 0);
  assert.equal(f.store.get(f.job.id).runs[0].stopped, false);
  assert.equal(f.launched.length, 1);
});

test('a receipt arriving during an exit probe is honoured without a false missing-receipt error', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.runtime.isAlive = async () => { f.report({ kind: 'plan', plan: plan() }); return false; };
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.equal(job.error, undefined);
  assert.ok(job.plan);
  assert.equal(job.runs[0].stopped, true);
  f.store.approvePlan(job.id, job.revision);
});

test('tick overlap does not duplicate side effects and paused-in-flight polling cannot merge', async (t) => {
  const f = fixture(t); await atPr(f);
  let release; f.github.pr = async () => { await new Promise((r) => { release = r; }); return { state: 'OPEN', checkStatus: 'passing', head: 'head1' }; };
  const pending = f.tick();
  while (!release) await new Promise((r) => setImmediate(r));
  await f.runner.tick(); f.store.action(f.job.id, 'pause'); release(); await pending;
  assert.equal(f.merged.length, 0);
});

test('pipeline API failure never turns old green evidence into a merge', async (t) => {
  const f = fixture(t); await atPr(f); f.github.pr = async () => { throw new Error('GitHub unavailable'); };
  await f.tick(); assert.equal(f.merged.length, 0); assert.match(f.store.get(f.job.id).subJobs[0].observationError, /unavailable/);
});

test('cleanup refusal remains visible and retryable', async (t) => {
  const f = fixture(t); await f.approve();
  f.alive.clear(); await f.tick();
  f.store.update(f.job.id, (j) => { const s = j.subJobs[0]; s.error = null; s.stage = 'cleanup'; s.deployed = { checks: ['Works'] }; });
  f.runtime.cleanup = async () => { throw new Error('Worktree contains local changes'); };
  await f.tick(); assert.equal(f.store.get(f.job.id).subJobs[0].stage, 'cleanup');
  assert.match(f.store.get(f.job.id).subJobs[0].error, /local changes/);
});

test('MCP receipts and context are caller-bound and launch-allowlisted', async (t) => {
  const f = fixture(t); await f.approve(); const w = f.last();
  const deps = { jobStore: f.store };
  assert.equal((await getJobContextTool.handler({ deps, caller: 'other' })).structuredContent.job, null);
  assert.equal((await getJobContextTool.handler({ deps, caller: w.sid })).structuredContent.run.id, w.run.id);
  const report = { kind: 'local', commitMessage: 'AUTH-123: change', checks: ['Tests pass'] };
  assert.equal((await jobReportTool.handler({ deps, caller: 'other' }, { runId: w.run.id, report })).isError, true);
  assert.equal((await jobReportTool.handler({ deps, caller: w.sid }, { runId: w.run.id, report })).structuredContent.accepted, true);
  assert.match(allowedToolsArg({ checklist: false }), /job_report/); assert.match(allowedToolsArg(), /get_job_context/);
});

test('job control routes validate input and return a concrete creation acknowledgement', async (t) => {
  const f = fixture(t), sent = [];
  const ctx = { jobStore: f.store, rebuild: async () => {}, reply: (x) => sent.push(x) };
  await routeControlMessage(JSON.stringify({ type: 'job-create', job: input }), ctx);
  assert.equal(sent[0].type, 'job-created');
  await routeControlMessage(JSON.stringify({ type: 'job-settings', patch: { concurrency: 0 } }), ctx);
  assert.equal(sent[1].type, 'error'); assert.equal(f.store.snapshot().settings.concurrency, 2);
});

const rawPr = { url: 'https://github.com/org/repo/pull/1', state: 'OPEN', headRefName: 'branch-api', headRefOid: 'head1', baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', conclusion: 'SUCCESS' }] };
const reviewRequiredPr = { ...rawPr, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE' };
function reviewGithub(raw = reviewRequiredPr, { classic = { contexts: ['tests'] }, rules = [], runs = [] } = {}) {
  const calls = [];
  const gh = new JobGithub(async (_bin, args) => {
    calls.push(args);
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo' });
    if (args[0] === 'pr') return JSON.stringify(raw);
    if (args[1].includes('/rules/branches/')) return JSON.stringify([rules]);
    if (args[1].includes('/check-runs?')) return JSON.stringify([{ check_runs: runs }]);
    if (args[1].includes('/branches/')) return JSON.stringify({ protection: { required_status_checks: classic } });
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  });
  const sub = { repo: '/repo', worktree: { branch: rawPr.headRefName }, pr: { url: rawPr.url, head: rawPr.headRefOid, mergeWithAdmin: true } };
  return { gh, calls, sub };
}
test('publication and repair receipts give reviewers ten seconds before the first PR observation', async (t) => {
  const f = fixture(t); await atPr(f);
  let sub = f.store.get(f.job.id).subJobs[0];
  assert.ok(sub.nextPollAt > Date.now() + 9000 && sub.nextPollAt <= Date.now() + 10000, 'a fresh PR settles for 10s');
  f.setPr({ checkStatus: 'failing' }); await f.tick(); assert.equal(f.last().run.phase, 'repair');
  f.report({ kind: 'repaired', changes: ['Fixed test'], checks: ['Tests pass'] });
  sub = f.store.get(f.job.id).subJobs[0];
  assert.ok(sub.nextPollAt > Date.now() + 9000, 'a repair push settles again');
});

test('PR comments are read with every poll, triaged once per comment set and shaded on the sub-job', async (t) => {
  const f = fixture(t); await atPr(f);
  await f.tick(); await f.runner.idle();
  let sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.prComments.items.length, 0); assert.equal(sub.commentSummary, null); assert.deepEqual(f.triaged, []);
  f.setComments(resource({ reviews: [{ ...node('r1', 'alice', 'Looks good', '2026-09-08T10:00:00Z'), state: 'APPROVED', submittedAt: '2026-09-08T10:00:00Z' }],
    comments: [node('c1', 'coverage-bot', 'Coverage 91%', '2026-09-08T10:00:05Z', { bot: true })] }));
  await f.tick(); await f.runner.idle();
  sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.prComments.items.length, 2); assert.equal(sub.prComments.items[1].bot, true);
  assert.equal(sub.commentSummary.tone, 'green'); assert.equal(sub.commentSummary.fingerprint, sub.prComments.fingerprint);
  assert.deepEqual(f.attributed, ['live-triage'], 'the triage spend is billed to the sub-job session');
  await f.tick(); await f.runner.idle();
  assert.equal(f.triaged.length, 1, 'an unchanged comment set is not re-triaged');
  assert.deepEqual(new JobStore(f.store.file).get(f.job.id).subJobs[0].commentSummary, sub.commentSummary);
});

test('a red verdict holds automatic merging until the head is approved; amber and green merge', async (t) => {
  const thread = (resolved) => resource({ threads: [{ id: 't1', resolved, comments: [node('tc1', 'bob', 'This drops the auth check; do not merge', '2026-09-08T10:00:00Z')] }] });
  for (const tone of ['red', 'amber', 'green']) {
    const f = fixture(t); await atPr(f);
    f.setVerdict(async () => ({ tone, text: `${tone} verdict`, liveSessionId: `live-${tone}` }));
    f.setComments(thread(false)); f.setPr({ checkStatus: 'passing' });
    await f.tick(); assert.equal(f.merged.length, 0, `${tone}: the verdict is still being written on the first poll`);
    await f.runner.idle(); await f.tick();
    const sub = f.store.get(f.job.id).subJobs[0];
    assert.equal(commentsBlockMerge(sub), tone === 'red');
    assert.equal(f.merged.length, tone === 'red' ? 0 : 1, tone);
    if (tone !== 'red') continue;
    assert.equal(sub.commentSummary.tone, 'red');
    f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
    await f.tick(); assert.deepEqual(f.merged, ['head1'], 'an explicit approval overrides the hold');
    // Resolving the thread changes the fingerprint and re-triages it.
    f.setVerdict(async () => ({ tone: 'green', text: 'Resolved', liveSessionId: 'live-2' }));
    f.setComments(thread(true)); await f.tick(); await f.runner.idle();
    assert.equal(f.store.get(f.job.id).subJobs[0].commentSummary.tone, 'green'); assert.equal(f.triaged.length, 2);
  }
});

test('a failed triage is an amber unavailable verdict that never blocks merging, and a stale verdict is dropped', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setVerdict(async () => { throw new Error('claude exited 1'); });
  f.setComments(resource({ comments: [node('c1', 'alice', 'Question?', '2026-09-08T10:00:00Z')] })); f.setPr({ checkStatus: 'passing' });
  await f.tick(); await f.runner.idle();
  let sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.commentSummary.tone, 'amber'); assert.equal(sub.commentSummary.error, true); assert.match(sub.commentSummary.text, /unavailable/);
  await f.tick(); assert.deepEqual(f.merged, ['head1']);
  // A verdict that finishes after the comments moved on never lands on the newer set.
  let release; f.setVerdict(() => new Promise((r) => { release = r; }));
  f.setComments(resource({ comments: [node('c1', 'alice', 'Question?', '2026-09-08T10:00:00Z'), node('c2', 'bob', 'Bug here', '2026-09-08T10:01:00Z')] }));
  await f.tick();
  f.setComments(resource({ comments: [node('c1', 'alice', 'Question?', '2026-09-08T10:00:00Z'), node('c2', 'bob', 'Bug here', '2026-09-08T10:01:00Z'), node('c3', 'bob', 'Never mind, fixed', '2026-09-08T10:02:00Z')] }));
  const second = new Promise((r) => f.setVerdict(async () => { r(); return { tone: 'green', text: 'Fine', liveSessionId: 'live-3' }; }));
  await f.tick(); await second;
  release({ tone: 'red', text: 'Stale', liveSessionId: 'live-stale' }); await f.runner.idle();
  sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.commentSummary.tone, 'green'); assert.equal(sub.commentSummary.fingerprint, sub.prComments.fingerprint);
  assert.ok(f.attributed.includes('live-stale'), 'even a discarded triage spent tokens and is billed');
});

test('a comments read failure is an observation error that keeps the previous PR evidence', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ checkStatus: 'passing' });
  f.store.update(f.job.id, (j) => { j.reviewMerge = true; });
  await f.tick(); assert.equal(f.store.get(f.job.id).subJobs[0].pr.head, 'head1');
  f.github.comments = async () => { throw new Error('GraphQL rate limited'); };
  await f.tick(); const sub = f.store.get(f.job.id).subJobs[0];
  assert.match(sub.observationError, /rate limited/); assert.equal(sub.pr.head, 'head1'); assert.equal(f.merged.length, 0);
});

test('GitHub readiness never treats running, failed, draft or blocked checks as green', () => {
  assert.equal(prSummary(rawPr).checkStatus, 'passing');
  for (const patch of [{ statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] }, { statusCheckRollup: [{ conclusion: 'FAILURE' }] }, { isDraft: true }, { mergeStateStatus: 'BLOCKED' }]) assert.notEqual(prSummary({ ...rawPr, ...patch }).checkStatus, 'passing');
});

test('required review can be overridden only with green checks and confirmed mergeability', () => {
  assert.equal(prSummary(reviewRequiredPr).checkStatus, 'passing');
  assert.equal(prSummary(reviewRequiredPr).mergeWithAdmin, true);
  for (const patch of [
    { statusCheckRollup: [] }, { statusCheckRollup: null },
    ...['IN_PROGRESS', 'QUEUED', 'WAITING', 'UNKNOWN'].map(status => ({ statusCheckRollup: [{ status, conclusion: 'SUCCESS' }] })),
    ...['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'UNKNOWN'].map(conclusion => ({ statusCheckRollup: [{ conclusion }] })),
    { statusCheckRollup: [{ context: 'legacy CI', state: 'PENDING' }] },
    { isDraft: true }, { state: 'CLOSED' }, { state: 'MERGED' },
    ...['DIRTY', 'BEHIND', 'UNKNOWN', 'UNSTABLE'].map(mergeStateStatus => ({ mergeStateStatus })),
    ...['UNKNOWN', 'CONFLICTING', undefined].map(mergeable => ({ mergeable })),
    { reviewDecision: 'CHANGES_REQUESTED' }, { reviewDecision: 'APPROVED' }, { reviewDecision: undefined },
  ]) {
    const summary = prSummary({ ...reviewRequiredPr, ...patch });
    assert.equal(summary.mergeWithAdmin, false, JSON.stringify(patch));
    assert.notEqual(summary.checkStatus, 'passing', JSON.stringify(patch));
  }
  assert.equal(prSummary({ ...reviewRequiredPr, statusCheckRollup: [{ context: 'legacy CI', state: 'SUCCESS' }] }).checkStatus, 'passing');
});

test('review override verifies missing checks from branch protection and rulesets', async () => {
  for (const policy of [
    { classic: { contexts: ['tests', 'plan'] } },
    { classic: { checks: [{ context: 'plan', app_id: null }] } },
    { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'plan', integration_id: null }] } }] },
  ]) {
    const { gh, sub, calls } = reviewGithub(reviewRequiredPr, policy);
    const pr = await gh.pr(sub);
    assert.equal(pr.checkStatus, 'pending'); assert.equal(pr.mergeWithAdmin, false);
    assert.deepEqual(pr.checks.at(-1), { name: 'plan', state: 'PENDING' });
    await assert.rejects(gh.merge(sub), /no longer green/);
    assert.ok(!calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
  }
});

test('required check app identity and commit must match before overriding review', async () => {
  const policy = { classic: { checks: [{ context: 'tests', app_id: 123 }] } };
  const run = { name: 'tests', app: { id: 123 }, head_sha: 'head1', status: 'completed', conclusion: 'success' };
  for (const runs of [[], [{ ...run, app: { id: 456 } }], [{ ...run, head_sha: 'old' }], [{ ...run, status: 'in_progress' }], [{ ...run, conclusion: 'failure' }]]) {
    const { gh, sub } = reviewGithub(reviewRequiredPr, { ...policy, runs });
    assert.equal((await gh.pr(sub)).mergeWithAdmin, false);
  }
  const { gh, sub } = reviewGithub(reviewRequiredPr, { ...policy, runs: [run] });
  assert.equal((await gh.pr(sub)).mergeWithAdmin, true);
});

test('admin merge re-observes readiness, pins the head, and drops admin when review is approved', async () => {
  for (const [raw, admin] of [[reviewRequiredPr, true], [{ ...rawPr, reviewDecision: 'APPROVED' }, false]]) {
    const { gh, sub, calls } = reviewGithub(raw);
    await gh.merge(sub);
    assert.equal(calls[0][1], 'view');
    assert.deepEqual(calls.at(-1), ['pr', 'merge', rawPr.url, '--squash', ...(admin ? ['--admin'] : []), '--match-head-commit', 'head1']);
  }
  for (const patch of [{ headRefOid: 'head2' }, { statusCheckRollup: [{ name: 'tests', conclusion: 'FAILURE' }] }, { reviewDecision: 'CHANGES_REQUESTED' }]) {
    const { gh, sub, calls } = reviewGithub({ ...reviewRequiredPr, ...patch });
    await assert.rejects(gh.merge(sub), /PR changed or checks are no longer green/);
    assert.ok(!calls.some(args => args[1] === 'merge'));
  }
});

test('failure to observe required checks never permits an admin merge', async () => {
  const { gh, sub, calls } = reviewGithub();
  const run = gh.run;
  gh.run = async (bin, args, cwd) => {
    if (args[0] === 'api') throw new Error('GitHub unavailable');
    return run(bin, args, cwd);
  };
  await assert.rejects(gh.pr(sub), /unavailable/);
  await assert.rejects(gh.merge(sub), /unavailable/);
  assert.ok(!calls.some(args => args[1] === 'merge'));
});

test('review override preserves manual merge approval and automatic merge behaviour', async (t) => {
  for (const reviewMerge of [true, false]) {
    const f = fixture(t, { ...input, reviewMerge }); await atPr(f);
    f.store.update(f.job.id, j => { j.reviewMerge = reviewMerge; });
    f.setPr(prSummary(reviewRequiredPr)); await f.tick();
    assert.equal(f.merged.length, reviewMerge ? 0 : 1);
    if (reviewMerge) {
      f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
      f.setPr({ head: 'head2' }); await f.tick(); assert.equal(f.merged.length, 0);
      f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head2' });
      await f.tick(); assert.deepEqual(f.merged, ['head2']);
    }
  }
});

test('pausing during the admin recheck prevents merging and leaves the merge retryable', async (t) => {
  const f = fixture(t); await atPr(f);
  const { gh, calls } = reviewGithub();
  const observe = gh.pr.bind(gh);
  gh.pr = async sub => {
    const pr = await observe(sub);
    f.store.action(f.job.id, 'pause');
    return pr;
  };
  f.github.merge = gh.merge.bind(gh);
  f.setPr(prSummary(reviewRequiredPr)); await f.tick();
  assert.ok(!calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
  assert.equal(f.store.get(f.job.id).subJobs[0].mergeRequestedHead, undefined);
  gh.pr = observe; f.store.action(f.job.id, 'resume'); await f.tick();
  assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, 1);
});

test('GitHub PR observer verifies repository and worktree branch, merge pins head', async () => {
  const calls = [];
  const gh = new JobGithub(async (bin, args) => { calls.push(args); return JSON.stringify(args[0] === 'repo' ? { nameWithOwner: 'org/repo' } : rawPr); });
  const sub = { repo: '/repo', worktree: { branch: 'branch-api' }, pr: { url: rawPr.url, head: 'head1' } };
  await gh.pr(sub); await gh.merge(sub);
  assert.deepEqual(calls.at(-1).slice(-2), ['--match-head-commit', 'head1']);
  assert.ok(!calls.at(-1).includes('--admin'));
  await assert.rejects(gh.pr({ ...sub, worktree: { branch: 'other' } }), /does not belong/);
  gh.run = async (bin, args) => { calls.push(args); return JSON.stringify({ data: { resource: resource({ comments: [node('c1', 'alice', 'Nice', '2026-09-08T10:00:00Z')] }) } }); };
  const comments = await gh.comments(sub);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['api', 'graphql']); assert.ok(calls.at(-1).includes(`url=${rawPr.url}`));
  assert.equal(comments.items[0].author, 'alice'); assert.equal(comments.prAuthor, 'agent');
  gh.run = async () => JSON.stringify({ data: { resource: null } });
  await assert.rejects(gh.comments(sub), /not found/);
});

test('deployment observer discovers the runs GitHub started for the exact merge commit', async () => {
  const sub = { repo: '/repo', pr: { mergeCommit: 'merged', base: 'main' }, deployment: { verify: 'hit /health' } };
  const good = { databaseId: 1, headSha: 'merged', headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success', attempt: 1, workflowName: 'Deploy' };
  const calls = [];
  const gh = new JobGithub(async (_bin, args) => { calls.push(args); return JSON.stringify([good]); });
  assert.equal((await gh.deployment(sub)).status, 'passing');
  // One query, pinned to the merge commit rather than the branch: a sibling
  // sub-job merging into the same repo must not become this one's evidence.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--commit') && calls[0].includes('merged'));
  assert.ok(!calls[0].includes('--workflow') && !calls[0].includes('--branch'));

  // No run at all is never success: it cannot be told apart from a run that has
  // not been queued yet, so the runner flags a lasting silence for the human.
  gh.run = async () => JSON.stringify([]);
  const silent = await gh.deployment(sub);
  assert.equal(silent.status, 'pending'); assert.deepEqual(silent.runs, []);

  gh.run = async () => JSON.stringify([{ ...good, headSha: 'unrelated' }]);
  assert.equal((await gh.deployment(sub)).status, 'pending', 'a run on another commit is not evidence');
  gh.run = async () => JSON.stringify([{ ...good, event: 'pull_request' }]);
  assert.equal((await gh.deployment(sub)).status, 'pending', 'the PR gate was already judged before the merge');

  gh.run = async () => JSON.stringify([good, { ...good, databaseId: 2, workflowName: 'Scan', status: 'in_progress', conclusion: '' }]);
  assert.equal((await gh.deployment(sub)).status, 'pending', 'one discovered run still in flight holds the verdict');
  gh.run = async () => JSON.stringify([good, { ...good, databaseId: 2, workflowName: 'Scan', conclusion: 'failure' }]);
  assert.equal((await gh.deployment(sub)).status, 'failing');

  // A skipped run is GitHub saying the workflow did not apply: it neither blocks
  // nor satisfies, so all-skipped reads as silence rather than a deployment.
  gh.run = async () => JSON.stringify([{ ...good, conclusion: 'skipped' }]);
  const skipped = await gh.deployment(sub);
  assert.equal(skipped.status, 'pending'); assert.equal(skipped.runs[0].status, 'skipped');
  gh.run = async () => JSON.stringify([good, { ...good, databaseId: 2, workflowName: 'Scan', conclusion: 'skipped' }]);
  assert.equal((await gh.deployment(sub)).status, 'passing', 'a skipped sibling does not hold back a real deploy');

  // One workflow can run twice on a commit (a re-run, or a scan that starts
  // twice); the latest attempt is the live one.
  gh.run = async () => JSON.stringify([{ ...good, databaseId: 9, conclusion: 'failure' }, { ...good, databaseId: 9, attempt: 2 }]);
  const rerun = await gh.deployment(sub);
  assert.equal(rerun.status, 'passing'); assert.equal(rerun.runs.length, 1);
});

test('idle ticks and exhausted claims do not rewrite state or trigger extra graph rebuilds', async (t) => {
  const f = fixture(t); let rebuilt = 0; f.runner.onChange = async () => { rebuilt++; };
  const before = f.store.data; await f.tick(); assert.equal(rebuilt, 0); assert.equal(f.store.data, before);
  f.store.action(f.job.id, 'start'); await f.tick(); assert.equal(rebuilt, 1);
  const running = f.store.data; assert.equal(f.store.claim(f.job.id, null, 'planning'), null); assert.equal(f.store.data, running);
  await f.tick(); assert.equal(rebuilt, 1);
});

test('cancel stops the live step, ignores its late receipt and moves the sub-job straight to cleanup', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web', ['api'])]));
  const worker = f.launched.find((w) => w.sub?.id === 'api');
  f.store.action(f.job.id, 'cancel', { subJobId: 'api' });
  let api = f.store.get(f.job.id).subJobs[0];
  assert.equal(api.stage, 'cleanup'); assert.ok(api.cancelledAt);
  f.report({ kind: 'local', commitMessage: 'AUTH-123: api', checks: ['Tests pass'] }, worker);
  api = f.store.get(f.job.id).subJobs[0];
  assert.equal(api.stage, 'cleanup', 'a racing receipt must not move a cancelled sub-job'); assert.equal(api.local, null); assert.equal(api.state, 'cancelled');
  await f.tick();
  assert.ok(f.stopped.includes(worker.run.id)); assert.deepEqual(f.cleaned, ['api']);
  api = f.store.get(f.job.id).subJobs[0];
  assert.equal(api.stage, 'done'); assert.equal(api.state, 'cancelled'); assert.equal(api.error, null);
  assert.throws(() => f.store.action(f.job.id, 'cancel', { subJobId: 'api' }), /already finished/);
  assert.throws(() => f.store.action(f.job.id, 'cancel'), /Choose a sub-job/);
  assert.equal(f.store.get(f.job.id).stage, 'active', 'the dependent sub-job still needs a decision');
});

const sessionSpec = (id, dependsOn = []) => ({ id, kind: 'session', title: `Run ${id}`, storyId: 'story', dependsOn, instructions: `Do ${id} on this machine` });

test('a session sub-job runs as a scratch step, needs review, and is a hard prerequisite for dependent builds', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('spike'), spec('api', ['spike']), sessionSpec('backfill', ['api'])]));
  assert.deepEqual(f.launched.slice(1).map((w) => [w.sub.id, w.run.phase]), [['spike', 'session']], 'a build behind a session waits to start');
  assert.deepEqual(f.store.get(f.job.id).repos, ['/repo'], 'sessions contribute no repository');
  assert.throws(() => f.report({ kind: 'local', commitMessage: 'AUTH-123: x', checks: ['Tests pass'] }), /must submit completed/);
  f.report({ kind: 'completed', checks: ['Schema documented in task memory'] });
  await f.tick();
  let spike = f.store.get(f.job.id).subJobs[0];
  assert.equal(spike.stage, 'review'); assert.equal(spike.result.receiptId, f.last().run.id);
  assert.equal(f.launched.length, 2, 'nothing starts while the session result awaits review');
  assert.throws(() => f.store.action(f.job.id, 'approve-session', { subJobId: 'spike', sessionReceiptId: 'other' }), /not ready/);
  f.store.action(f.job.id, 'approve-session', { subJobId: 'spike', sessionReceiptId: spike.result.receiptId });
  assert.equal(f.store.get(f.job.id).subJobs[0].stage, 'cleanup');
  await f.tick();
  spike = f.store.get(f.job.id).subJobs[0];
  assert.equal(spike.stage, 'done'); assert.deepEqual(f.cleaned, ['spike']);
  assert.deepEqual(f.last().sub.id, 'api'); assert.equal(f.last().run.phase, 'implementation');
  assert.equal(f.launched.filter((w) => w.sub?.id === 'backfill').length, 0, 'a session behind a PR waits for its deployment');
  f.report({ kind: 'local', commitMessage: 'AUTH-123: api', checks: ['Tests pass'] }); await f.tick();
  const api = f.store.get(f.job.id).subJobs[1];
  assert.equal(api.dependenciesVerified, true, 'the finished session satisfies the dependency');
  f.store.update(f.job.id, (j) => { j.subJobs[1].deployed = { checks: ['Live'] }; j.subJobs[1].stage = 'done'; });
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['backfill', 'session']);
});

test('with session review off a completed session goes straight to done; request changes reruns it with feedback', async (t) => {
  const f = fixture(t, { ...input, reviewSessions: false });
  await f.approve(plan([sessionSpec('spike')]));
  f.report({ kind: 'completed', checks: ['Done'] }); await f.tick();
  assert.equal(f.store.get(f.job.id).subJobs[0].stage, 'done'); assert.equal(f.store.get(f.job.id).stage, 'done');

  const g = fixture(t);
  await g.approve(plan([sessionSpec('spike')]));
  g.report({ kind: 'completed', checks: ['Done'] }); await g.tick();
  assert.throws(() => g.store.action(g.job.id, 'revise-session', { subJobId: 'spike' }), /Explain/);
  g.store.action(g.job.id, 'revise-session', { subJobId: 'spike', feedback: 'Also check staging' });
  let spike = g.store.get(g.job.id).subJobs[0];
  assert.equal(spike.stage, 'session'); assert.equal(spike.result, null);
  await g.tick();
  assert.equal(g.last().run.phase, 'session'); assert.equal(g.last().sub.feedback, 'Also check staging');
  g.report({ kind: 'completed', checks: ['Staging checked'] }); await g.tick();
  spike = g.store.get(g.job.id).subJobs[0];
  assert.equal(spike.stage, 'review'); assert.equal(spike.feedback, null);
  g.store.action(g.job.id, 'cancel', { subJobId: 'spike' }); await g.tick();
  assert.deepEqual([spike = g.store.get(g.job.id).subJobs[0]].map((s) => [s.stage, s.state]), [['done', 'cancelled']]);
});

test('plans keep PR and session sub-jobs distinct: a session has no repo, a PR needs one', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...sessionSpec('a'), repo: '/repo' }]) }), /session sub-job has no repo/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), repo: undefined }]) }), /PR sub-job needs repo/);
  const g = fixture(t); g.store.action(g.job.id, 'start'); await g.tick();
  assert.doesNotThrow(() => g.report({ kind: 'plan', plan: plan([{ ...spec('a'), deployment: undefined }]) }), 'a PR that deploys nothing is a PR without deployment');
  f.report({ kind: 'plan', plan: plan([sessionSpec('a'), spec('b', ['a'])]) });
  assert.deepEqual(f.store.get(f.job.id).repos, ['/repo']);
  assert.equal(f.store.get(f.job.id).plan.subJobs[1].kind, 'pr');
});

test('a plan carries no branch names: the implementer names its branch, and only its own rename moves the sub-job\'s worktree record', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([{ ...spec('api'), branch: 'feat/{key}-api' }, spec('web')]) }); await f.tick();
  assert.equal('branch' in f.store.get(f.job.id).plan.subJobs[0], false, 'a proposed branch is dropped, not stored');
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision); await f.tick();
  const [api, web] = f.launched.slice(1);
  assert.equal(f.store.get(f.job.id).subJobs[0].worktree.branch, 'branch-api', 'launched on the placeholder');
  assert.equal(f.store.noteBranchRename('session-nobody', 'fix/AUTH-123-x'), false, 'a session that is not a job run touches nothing');
  assert.equal(f.store.noteBranchRename(api.sid, 'fix/AUTH-123-reliable-sign-in'), true);
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.map((s) => s.worktree.branch), ['fix/AUTH-123-reliable-sign-in', 'branch-web'], 'only the renaming session\'s own sub-job follows');
  assert.equal(job.subJobs[0].worktree.path, '/worktree/api', 'the rest of the worktree record is kept');
  f.report({ kind: 'local', commitMessage: 'AUTH-123: api', checks: ['Tests passed'] }, api); await f.tick();
  assert.equal(f.store.noteBranchRename(web.sid, 'fix/AUTH-123-web'), true);
  assert.equal(f.store.get(f.job.id).subJobs[1].worktree.branch, 'fix/AUTH-123-web');
});

test('approving a plan with proposed stories runs a Jira step whose keys, and only those, unlock implementation', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const proposed = { stories: [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in', value: 'Customers can access their account' }, { id: 'audit', project: 'SEC', title: 'Sign-ins are audited', value: 'Security can trace access' }],
    subJobs: [spec('api'), { ...spec('web'), storyId: 'audit' }] };
  f.report({ kind: 'plan', plan: proposed }); await f.tick();
  assert.throws(() => f.report({ kind: 'plan', plan: { ...proposed, stories: [{ id: 'x', key: 'bad key', title: 'a', value: 'b' }] } }), undefined, 'a keyed story still needs a real key');
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision); await f.tick();
  let job = f.store.get(f.job.id);
  assert.equal(job.stage, 'jira'); assert.deepEqual(job.subJobs, [], 'no worktree or implementation before the tickets exist');
  assert.equal(f.last().run.phase, 'jira'); assert.equal(f.last().sub, null);
  assert.match(f.last().run.id, /^run_/);
  assert.throws(() => f.report({ kind: 'local', commitMessage: 'x: y', checks: ['a'] }), /must submit jira/);
  assert.throws(() => f.report({ kind: 'jira', stories: [{ id: 'nope', key: 'SEC-1' }] }), /Unknown story/);
  assert.throws(() => f.report({ kind: 'jira', stories: [{ id: 'story', key: 'AUTH-999' }] }), /approved as AUTH-123/);
  assert.throws(() => f.report({ kind: 'jira', stories: [{ id: 'story', key: 'AUTH-123' }] }), /still missing: audit/);
  assert.equal(f.store.get(f.job.id).stage, 'jira', 'a rejected receipt changes nothing');
  f.report({ kind: 'jira', stories: [{ id: 'audit', key: 'SEC-42' }] });
  job = f.store.get(f.job.id);
  assert.equal(job.stage, 'active');
  assert.deepEqual(job.plan.stories.map((s) => s.key), ['AUTH-123', 'SEC-42']);
  assert.deepEqual(job.subJobs.map((s) => s.jiraKey), ['AUTH-123', 'SEC-42']);
  await f.tick();
  assert.deepEqual(f.launched.slice(2).map((w) => [w.run.phase, w.sub.id]), [['implementation', 'api'], ['implementation', 'web']]);
  assert.ok(f.stopped.includes(f.launched[1].run.id), 'the ticketing session is released like planning');
  assert.deepEqual(new JobStore(f.store.file).get(f.job.id).subJobs.map((s) => s.jiraKey), ['AUTH-123', 'SEC-42']);
});

test('a blocked Jira step is retryable from the same column and a fully keyed plan skips it', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: { ...plan(), stories: [{ id: 'story', title: 'Reliable sign-in', value: 'Customers can access their account' }] } }); await f.tick();
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision); await f.tick();
  f.report({ kind: 'blocked', summary: 'Jira search failed: 401 from the Atlassian MCP' }); await f.tick();
  let job = f.store.get(f.job.id);
  assert.equal(job.stage, 'jira'); assert.match(job.error, /401/); assert.equal(f.launched.length, 2);
  f.store.action(f.job.id, 'retry'); await f.tick();
  assert.equal(f.launched.length, 3); assert.equal(f.last().run.phase, 'jira');
  f.report({ kind: 'jira', stories: [{ id: 'story', key: 'AUTH-7' }] }); await f.tick();
  assert.equal(f.store.get(f.job.id).stage, 'active'); assert.equal(f.last().run.phase, 'implementation');
  assert.equal(f.store.get(f.job.id).subJobs[0].jiraKey, 'AUTH-7');
  const g = fixture(t); await g.approve();
  assert.deepEqual(g.launched.map((w) => w.run.phase), ['planning', 'implementation'], 'existing keys mean nothing to write in Jira');
});

test('a PR sub-job with no deployment is deployed by its merge: dependants are released and no verify session runs', async (t) => {
  const f = fixture(t); f.store.update(f.job.id, (j) => { j.reviewCode = false; j.reviewMerge = false; });
  const { deployment, ...docs } = spec('docs');
  await f.approve(plan([docs, spec('api', ['docs'])]));
  assert.equal(f.store.get(f.job.id).subJobs[0].deployment, undefined);
  const docsRun = f.launched.find((l) => l.sub?.id === 'docs');
  f.report({ kind: 'local', commitMessage: 'AUTH-123: docs', checks: ['Lint passed'] }, docsRun); await f.tick();
  f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/1' }, f.launched.find((l) => l.sub?.id === 'docs' && l.run.phase === 'publish')); await f.tick();
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  const docsSub = f.store.get(f.job.id).subJobs[0];
  assert.equal(docsSub.stage, 'cleanup'); assert.equal(docsSub.deployed.commit, 'merge1'); assert.ok(docsSub.mergedAt);
  assert.match(docsSub.deployed.checks[0], /nothing deploys/);
  assert.equal(f.launched.some((l) => l.run.phase === 'verify'), false);
  await f.tick(); assert.deepEqual(f.cleaned, ['docs']);
  assert.equal(f.store.get(f.job.id).subJobs[1].dependenciesVerified, undefined);
  // The dependant now re-verifies against its "deployed" prerequisite exactly as it would after a real deploy.
  f.report({ kind: 'local', commitMessage: 'AUTH-123: api', checks: ['Tests pass'] }, f.launched.find((l) => l.sub?.id === 'api')); await f.tick();
  assert.equal(f.store.get(f.job.id).subJobs[1].dependenciesVerified, true);
});

test('a merged sub-job with nothing deployed past the stale window is flagged; a slow run in progress is not', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  const sub = () => f.store.get(f.job.id).subJobs[0];
  assert.ok(sub().mergedAt);
  f.setDeployment({ status: 'pending', runs: [], commit: 'merge1' });
  await f.tick(); assert.equal(sub().deploymentStale, null, 'inside the window it is just waiting');
  for (let i = 0; i < 30; i++) await f.tick();
  assert.equal(sub().deploymentStale.since, sub().mergedAt);
  assert.ok(!sub().error, 'advisory: polling continues and nothing is blocked');
  // Everything GitHub started was skipped: it did not apply to this commit, so
  // this is silence too and must never read as a deployment.
  f.setDeployment({ status: 'pending', runs: [{ workflow: 'deploy.yml', runId: 7, status: 'skipped' }], commit: 'merge1' });
  await f.tick(); assert.ok(sub().deploymentStale, 'an all-skipped merge deployed nothing');
  f.setDeployment({ status: 'pending', runs: [{ workflow: 'deploy.yml', runId: 7, status: 'pending' }], commit: 'merge1' });
  await f.tick(); assert.equal(sub().deploymentStale, null, 'a run in progress is a slow deploy, never stale');
  f.setDeployment({ status: 'passing', runs: [{ workflow: 'deploy.yml', runId: 7, status: 'passing' }], commit: 'merge1' });
  await f.tick(); assert.equal(sub().deploymentStale, null); assert.equal(f.last().run.phase, 'verify');
  // A sub-job merged before this existed has no mergedAt; the window counts from its first observation.
  f.store.settings({ deploymentStaleMinutes: 5 });
  assert.throws(() => f.store.settings({ deploymentStaleMinutes: 1 }));
});

// --- Plan amendments (server/job-amendments.js) ---
const pendingOf = (f) => f.store.get(f.job.id).amendments.filter((a) => a.status === 'proposed');
const dropDeploy = (id) => ({ op: 'set-deployment', subJobId: id, deployment: null });

test('a human plan change is validated, applied at once and recorded; the plan and sub-jobs stay in step', async (t) => {
  const f = fixture(t);
  await f.approve(plan([spec('api'), spec('web', ['api'])]));
  const before = f.store.snapshot();
  assert.throws(() => f.store.action(f.job.id, 'propose-amendment', { subJobId: 'api', reason: 'x', ops: [{ op: 'set-repo', subJobId: 'api', repo: '/other' }] }), /Invalid/, 'frozen fields have no op');
  assert.throws(() => f.store.action(f.job.id, 'propose-amendment', { subJobId: 'api', reason: 'x', ops: [{ op: 'set-instructions', subJobId: 'api', instructions: 'Rewritten' }] }), /Wait for the session to stop/, 'a live run on the target refuses the change');
  assert.deepEqual(f.store.snapshot(), before, 'a refused change persists nothing');
  // web's implementation is live too; stop both so the plan can move.
  f.alive.clear(); await f.tick();
  for (const id of ['api', 'web']) f.store.action(f.job.id, 'retry', { subJobId: id });
  f.store.action(f.job.id, 'propose-amendment', { subJobId: 'web', reason: 'The web deploy pipeline ignores markdown', ops: [dropDeploy('web'), { op: 'remove-dependency', subJobId: 'web', dependsOn: 'api' }] });
  const job = f.store.get(f.job.id);
  const [a] = job.amendments;
  assert.equal(a.status, 'accepted'); assert.equal(a.proposedBy, 'human'); assert.equal(a.subJobId, 'web'); assert.equal(a.classification, 'weakening');
  assert.match(a.id, /^amd_/); assert.ok(a.decidedAt);
  assert.deepEqual(a.summary, ['Drop deployment for Deliver web: merging completes it', 'Deliver web no longer waits for Deliver api']);
  const web = job.subJobs[1];
  assert.equal(web.deployment, undefined); assert.deepEqual(web.dependsOn, []);
  assert.equal(job.plan.subJobs[1].deployment, undefined); assert.deepEqual(job.plan.subJobs[1].dependsOn, [], 'the approved plan follows the sub-job');
  assert.deepEqual(new JobStore(f.store.file).get(f.job.id).amendments, job.amendments);
  assert.throws(() => f.store.action(f.job.id, 'propose-amendment', { subJobId: 'web', reason: 'again', ops: [dropDeploy('web')] }), /Change 1 \(set-deployment on Deliver web\): no change/);
  assert.throws(() => f.store.action(f.job.id, 'propose-amendment', { subJobId: 'api', reason: 'loop', ops: [{ op: 'add-dependency', subJobId: 'api', dependsOn: 'web' }, { op: 'add-dependency', subJobId: 'web', dependsOn: 'api' }] }), /cycles/);
  assert.throws(() => f.store.action(f.job.id, 'propose-amendment', { reason: '', ops: [dropDeploy('api')] }));
});

test('each op has its side effect: added sub-jobs match activation, instructions restart implementation, pending checks and dependencies are rewritten', async (t) => {
  const f = fixture(t); f.store.update(f.job.id, (j) => { j.reviewCode = false; });
  await f.approve(plan([spec('api'), spec('web')]));
  f.report({ kind: 'local', commitMessage: 'AUTH-123: api', checks: ['Tests pass'], pendingChecks: ['CI green', 'Plan clean'] }, f.launched.find((w) => w.sub?.id === 'api'));
  f.report({ kind: 'local', commitMessage: 'AUTH-123: web', checks: ['Tests pass'] }, f.launched.find((w) => w.sub?.id === 'web'));
  f.store.action(f.job.id, 'pause'); await f.tick();
  f.store.action(f.job.id, 'propose-amendment', { subJobId: 'api', reason: 'Lint is a PR check too', ops: [{ op: 'set-pending-checks', subJobId: 'api', pendingChecks: ['CI green', 'Lint'] }] });
  let job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs[0].local.pendingChecks, ['CI green', 'Lint']); assert.equal(job.subJobs[0].local.checks[0], 'Tests pass', 'the receipt itself is untouched');
  f.store.action(f.job.id, 'propose-amendment', { subJobId: 'web', reason: 'Use the shared client', ops: [{ op: 'set-instructions', subJobId: 'web', instructions: 'Implement web with the shared client' }, { op: 'add-dependency', subJobId: 'web', dependsOn: 'api' }] });
  job = f.store.get(f.job.id);
  const web = job.subJobs[1];
  assert.equal(web.local, null); assert.equal(web.codeApprovedAt, null); assert.equal(web.dependenciesVerified, false); assert.equal(web.feedback, 'Use the shared client');
  assert.equal(web.instructions, 'Implement web with the shared client'); assert.deepEqual(web.dependsOn, ['api']); assert.deepEqual(job.plan.subJobs[1].dependsOn, ['api']);
  f.store.action(f.job.id, 'propose-amendment', { reason: 'Docs need a follow-up PR', ops: [{ op: 'add-sub-job', spec: { ...spec('docs', ['api']), repo: '/docs', deployment: undefined } }] });
  job = f.store.get(f.job.id);
  const docs = job.subJobs[2];
  assert.equal(docs.stage, 'implementation'); assert.equal(docs.state, 'queued'); assert.equal(docs.jiraKey, 'AUTH-123', 'the key comes from the story, as at activation');
  assert.deepEqual([docs.repairs, docs.sessions, docs.local, docs.pr, docs.prComments, docs.commentSummary, docs.deploymentResult, docs.result], [[], [], null, null, null, null, null, null]);
  assert.deepEqual(job.plan.subJobs.map((s) => s.id), ['api', 'web', 'docs']); assert.deepEqual(job.repos, ['/repo', '/docs']);
  f.store.settings({ concurrency: 4 }); f.store.action(f.job.id, 'resume'); await f.tick();
  assert.deepEqual(f.launched.slice(3).map((w) => [w.sub.id, w.run.phase, w.sub.feedback]), [['api', 'publish', undefined], ['web', 'implementation', 'Use the shared client'], ['docs', 'implementation', undefined]], 'the added sub-job runs like any other; the rewritten one restarts with the reason as feedback');
});

test('dropping the deployment of a merged sub-job that is still watching marks it deployed, exactly as a no-deployment merge does', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'pending', runs: [], commit: 'merge1' });
  for (let i = 0; i < 31; i++) await f.tick();
  let sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.stage, 'deployment'); assert.ok(sub.deploymentStale);
  f.store.action(f.job.id, 'propose-amendment', { subJobId: 'api', reason: 'Verify the docs site, not the API', ops: [{ op: 'set-deployment', subJobId: 'api', deployment: { verify: 'Docs site shows the change' } }] });
  sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.deploymentResult, null); assert.equal(sub.deploymentStale, null); assert.equal(sub.nextPollAt, 0);
  assert.equal(sub.deployment.verify, 'Docs site shows the change', 'a changed watch starts again');
  f.store.action(f.job.id, 'propose-amendment', { subJobId: 'api', reason: 'Nothing deploys at all', ops: [dropDeploy('api')] });
  sub = f.store.get(f.job.id).subJobs[0];
  assert.equal(sub.stage, 'cleanup'); assert.equal(sub.deployed.commit, 'merge1'); assert.match(sub.deployed.checks[0], /nothing deploys/);
  assert.equal(f.launched.some((l) => l.run.phase === 'verify'), false);
  await f.tick(); assert.deepEqual(f.cleaned, ['api']); assert.equal(f.store.get(f.job.id).stage, 'done');
  assert.throws(() => f.store.action(f.job.id, 'propose-amendment', { subJobId: 'api', reason: 'late', ops: [dropDeploy('api')] }), /only be amended while the job is active/);
});

test('an agent proposes on its receipt: an invalid amendment fails the report, a valid one waits for the human and accepting IS the retry', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ checkStatus: 'failing' }); await f.tick(); assert.equal(f.last().run.phase, 'repair');
  const before = f.store.snapshot();
  assert.throws(() => f.report({ kind: 'blocked', summary: 'Pipeline ignores markdown', amendment: { reason: 'r', ops: [dropDeploy('nope')] } }), /Change 1 \(set-deployment on nope\): no such sub-job/);
  assert.deepEqual(f.store.snapshot(), before, 'the receipt is not recorded either');
  f.report({ kind: 'blocked', summary: 'deployment-pipeline.yaml path-ignores **.md so no run will appear', amendment: { reason: 'Docs-only change never triggers the pipeline', ops: [dropDeploy('api')] } });
  await f.tick();
  let job = f.store.get(f.job.id); let sub = job.subJobs[0];
  assert.match(sub.error, /path-ignores/); assert.equal(sub.stage, 'pr');
  const [a] = job.amendments;
  assert.equal(a.status, 'proposed'); assert.equal(a.classification, 'weakening');
  assert.deepEqual(a.proposedBy, { runId: f.last().run.id, sessionId: f.last().sid, phase: 'repair', subJobId: 'api', receipt: 'blocked' });
  assert.equal(job.runs.find((r) => r.id === a.proposedBy.runId).report.amendment.reason, a.reason, 'the receipt keeps its amendment on the ledger');
  assert.throws(() => f.store.action(f.job.id, 'accept-amendment', { amendmentId: 'amd_missing' }), /No pending plan change/);
  f.store.action(f.job.id, 'accept-amendment', { amendmentId: a.id });
  job = f.store.get(f.job.id); sub = job.subJobs[0];
  assert.equal(job.amendments[0].status, 'accepted'); assert.ok(job.amendments[0].decidedAt);
  assert.equal(sub.error, null); assert.equal(sub.deployment, undefined); assert.equal(sub.state, 'watching'); assert.equal(sub.repairAllowance, 1, 'accept carries the retry semantics');
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.store.get(f.job.id).subJobs[0].stage, 'cleanup', 'merged with no deployment: delivered');
  assert.throws(() => f.store.action(f.job.id, 'accept-amendment', { amendmentId: a.id }), /No pending plan change/, 'decided once');
});

test('rejecting keeps the block and the feedback; a proposal the job has moved past becomes invalid with the reason', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  const api = f.launched.find((w) => w.sub?.id === 'api'), web = f.launched.find((w) => w.sub?.id === 'web');
  f.report({ kind: 'blocked', summary: 'web must land first', amendment: { reason: 'api reads the schema web ships', ops: [{ op: 'add-dependency', subJobId: 'api', dependsOn: 'web' }] } }, api);
  f.report({ kind: 'local', commitMessage: 'AUTH-123: web', checks: ['Tests pass'], amendment: { reason: 'web needs no deployment', ops: [dropDeploy('web')] } }, web);
  await f.tick();
  let [first, second] = pendingOf(f);
  assert.equal(first.proposedBy.receipt, 'blocked'); assert.equal(second.proposedBy.receipt, 'local');
  f.store.action(f.job.id, 'reject-amendment', { amendmentId: first.id, feedback: 'Ship them independently' });
  let job = f.store.get(f.job.id);
  assert.equal(job.amendments[0].status, 'rejected'); assert.equal(job.amendments[0].feedback, 'Ship them independently');
  assert.match(job.subJobs[0].error, /web must land first/, 'rejecting a blocked receipt\'s fix leaves the block for Retry');
  assert.deepEqual(job.subJobs[0].dependsOn, []);
  // web publishes and deploys before anyone looks at its proposal: it no longer applies.
  f.store.update(f.job.id, (j) => { j.subJobs[1].deployed = { checks: ['Live'] }; j.subJobs[1].stage = 'cleanup'; });
  f.store.action(f.job.id, 'accept-amendment', { amendmentId: second.id });
  job = f.store.get(f.job.id);
  assert.equal(job.amendments[1].status, 'invalid'); assert.match(job.amendments[1].error, /already deployed/);
  assert.equal(job.subJobs[1].deployment.verify, 'Check running version and sign-in', 'nothing applied');
  assert.equal(pendingOf(f).length, 0);
});

test('accepting refuses while a run is live on a targeted sub-job, and a receipt proposal targeting a busy sibling stays pending under auto', async (t) => {
  const f = fixture(t, { ...input, amendmentAuthority: 'auto' }); await f.approve(plan([spec('api'), spec('web')]));
  const api = f.launched.find((w) => w.sub?.id === 'api');
  f.report({ kind: 'blocked', summary: 'x', amendment: { reason: 'web should wait', ops: [{ op: 'add-dependency', subJobId: 'web', dependsOn: 'api' }] } }, api);
  let job = f.store.get(f.job.id);
  assert.equal(job.amendments[0].status, 'proposed', 'web\'s implementation is live, so even auto leaves it for the human');
  assert.throws(() => f.store.action(f.job.id, 'accept-amendment', { amendmentId: job.amendments[0].id }), /Wait for the session to stop/);
  assert.equal(f.store.get(f.job.id).amendments[0].status, 'proposed', 'a refusal decides nothing');
  f.report({ kind: 'local', commitMessage: 'AUTH-123: web', checks: ['ok'] }, f.launched.find((w) => w.sub?.id === 'web')); await f.tick();
  f.store.action(f.job.id, 'accept-amendment', { amendmentId: job.amendments[0].id });
  job = f.store.get(f.job.id);
  assert.equal(job.amendments[0].status, 'accepted'); assert.deepEqual(job.subJobs[1].dependsOn, ['api']); assert.equal(job.subJobs[0].error, null);
});

test('the authority setting decides what applies on the spot: review nothing, auto-tighten only tightening, auto everything including the retry', async (t) => {
  const tighten = { reason: 'web needs api', ops: [{ op: 'add-dependency', subJobId: 'web', dependsOn: 'api' }] };
  const loosen = { reason: 'nothing deploys', ops: [dropDeploy('api')] };
  const run = async (authority, amendment) => {
    const f = fixture(t, { ...input, amendmentAuthority: authority });
    await f.approve(plan([spec('api'), spec('web')]));
    f.report({ kind: 'local', commitMessage: 'AUTH-123: web', checks: ['ok'] }, f.launched.find((w) => w.sub?.id === 'web'));
    await f.tick();
    f.report({ kind: 'blocked', summary: 'stuck', amendment }, f.launched.find((w) => w.sub?.id === 'api'));
    await f.tick();
    const job = f.store.get(f.job.id);
    return { status: job.amendments[0].status, error: job.subJobs[0].error, job, f };
  };
  const reviewed = await run('review', tighten); assert.equal(reviewed.status, 'proposed'); assert.equal(reviewed.error, 'stuck');
  const tightened = await run('auto-tighten', tighten); assert.equal(tightened.status, 'auto-accepted'); assert.deepEqual(tightened.job.subJobs[1].dependsOn, ['api']);
  const held = await run('auto-tighten', loosen); assert.equal(held.status, 'proposed'); assert.equal(held.error, 'stuck', 'weakening waits for a human');
  const auto = await run('auto', loosen);
  assert.equal(auto.status, 'auto-accepted'); assert.equal(auto.error, null, 'the blocked sub-job is re-queued'); assert.equal(auto.job.subJobs[0].deployment, undefined);
  assert.equal(auto.job.subJobs[0].repairAllowance, 1);
  await auto.f.tick();
  assert.deepEqual(auto.f.last().sub.id, 'api'); assert.equal(auto.f.last().run.phase, 'implementation', 'and runs again without a human Retry');
  assert.equal(new JobStore(auto.f.store.file).get(auto.job.id).amendmentAuthority, 'auto');
  assert.equal(fixture(t).job.amendmentAuthority, 'review', 'the default reviews everything');
});

test('MCP round trip: a receipt with an amendment is accepted through job_report, and get_job_context shows pending proposals and the authority', async (t) => {
  const f = fixture(t); await f.approve(); const w = f.last();
  const deps = { jobStore: f.store };
  const bad = await jobReportTool.handler({ deps, caller: w.sid }, { runId: w.run.id, report: { kind: 'blocked', summary: 's', amendment: { reason: 'r', ops: [{ op: 'set-instructions', subJobId: 'api', instructions: 'Implement api' }] } } });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /no change/);
  const ok = await jobReportTool.handler({ deps, caller: w.sid }, { runId: w.run.id, report: { kind: 'blocked', summary: 'Needs a docs PR first', amendment: { reason: 'The docs must land first', ops: [{ op: 'add-sub-job', spec: { ...spec('docs'), deployment: undefined } }, { op: 'add-dependency', subJobId: 'api', dependsOn: 'docs' }] } } });
  assert.equal(ok.structuredContent.accepted, true);
  const ctx = (await getJobContextTool.handler({ deps, caller: w.sid })).structuredContent;
  assert.equal(ctx.amendmentAuthority, 'review'); assert.equal(ctx.pendingAmendments.length, 1); assert.equal(ctx.pendingAmendments[0].classification, 'neutral');
  assert.deepEqual(ctx.pendingAmendments[0].summary, ['Add PR sub-job “Deliver docs” in /repo', 'Deliver api now deploys after Deliver docs']);
  assert.equal(ctx.job.subJobs.length, 1, 'nothing applied until accepted');
  const repeat = await jobReportTool.handler({ deps, caller: w.sid }, { runId: w.run.id, report: { kind: 'blocked', summary: 'Needs a docs PR first', amendment: { reason: 'The docs must land first', ops: [{ op: 'add-sub-job', spec: { ...spec('docs'), deployment: undefined } }, { op: 'add-dependency', subJobId: 'api', dependsOn: 'docs' }] } } });
  assert.equal(repeat.structuredContent.accepted, true); assert.equal(f.store.get(f.job.id).amendments.length, 1, 'an identical retry proposes nothing twice');
});

test('a failed live check can propose its fix inside the job: no recovery job while pending or once accepted, and the failed sub-job delivers when the fix deploys', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'passing', runs: [], commit: 'merge1' }); await f.tick(); assert.equal(f.last().run.phase, 'verify');
  f.report({ kind: 'blocked', summary: 'Deployed endpoint returns 500 on empty payloads', amendment: { reason: 'The handler needs a null guard', ops: [
    { op: 'add-sub-job', spec: { ...spec('fix'), title: 'Guard empty payloads' } }, { op: 'set-recovered-by', subJobId: 'api', fixSubJobId: 'fix' }] } });
  await f.tick(); await f.tick();
  let job = f.store.get(f.job.id);
  assert.equal(f.store.snapshot().jobs.length, 1, 'no recovery job while the in-job fix is proposed');
  assert.match(job.subJobs[0].error, /500/); assert.equal(job.subJobs[0].stage, 'deployment'); assert.equal(job.amendments[0].status, 'proposed');
  f.store.action(f.job.id, 'accept-amendment', { amendmentId: job.amendments[0].id });
  job = f.store.get(f.job.id);
  const [api, fix] = job.subJobs;
  assert.equal(api.recoveredBy, 'fix'); assert.equal(api.error, null); assert.equal(api.state, 'awaiting-fix'); assert.match(api.recoveryReason, /500/);
  assert.equal(fix.stage, 'implementation'); assert.equal(fix.title, 'Guard empty payloads');
  await f.tick(); await f.tick();
  assert.equal(f.store.snapshot().jobs.length, 1, 'accepted: still no recovery job');
  assert.equal(f.launched.filter((l) => l.run.phase === 'verify').length, 1, 'the failed sub-job is not re-verified while parked');
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['fix', 'implementation']);
  f.report({ kind: 'local', commitMessage: 'AUTH-123: guard', checks: ['Tests pass'] }); await f.tick();
  f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/2' }); f.setPr({ state: 'MERGED', mergeCommit: 'merge2', checkStatus: 'passing' }); await f.tick();
  f.setDeployment({ status: 'passing', runs: [{ workflow: 'deploy.yml', status: 'passing' }], commit: 'merge2' }); await f.tick();
  assert.equal(f.last().run.phase, 'verify'); assert.equal(f.last().sub.id, 'fix');
  f.report({ kind: 'deployed', checks: ['Empty payloads return 400'] }); await f.tick();
  job = f.store.get(f.job.id);
  assert.ok(['cleanup', 'done'].includes(job.subJobs[1].stage)); assert.equal(job.subJobs[0].stage, 'cleanup'); assert.match(job.subJobs[0].deployed.checks[0], /Recovered by Guard empty payloads/);
  assert.equal(job.subJobs[0].deployed.commit, 'merge1');
  await f.tick(); assert.deepEqual(f.cleaned.sort(), ['api', 'fix']); assert.equal(f.store.get(f.job.id).stage, 'done');
});

test('rejecting an in-job fix falls back to the separate recovery job on the next tick', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'passing', runs: [], commit: 'merge1' }); await f.tick();
  f.report({ kind: 'blocked', summary: 'Endpoint 500', amendment: { reason: 'Null guard', ops: [{ op: 'add-sub-job', spec: spec('fix') }, { op: 'set-recovered-by', subJobId: 'api', fixSubJobId: 'fix' }] } });
  await f.tick(); assert.equal(f.store.snapshot().jobs.length, 1);
  f.store.action(f.job.id, 'reject-amendment', { amendmentId: f.store.get(f.job.id).amendments[0].id });
  await f.tick();
  assert.equal(f.store.snapshot().jobs.length, 2); assert.equal(f.store.get(f.job.id).subJobs[0].stage, 'cleanup'); assert.equal(f.store.get(f.job.id).subJobs.length, 1);
});
