import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore, migrateJobs, MERGE_IS_DELIVERY } from './job-store.js';
import { JobRunner, IDLE_RECEIPT_GRACE_MS } from './job-runner.js';
import { JobGithub, prSummary } from './job-github.js';
import { normaliseComments, commentsBlockMerge } from './job-comments.js';
import { jobReportTool, getJobContextTool } from './mcp/tools/job-report.js';
import { allowedToolsArg } from './mcp/client-config.js';
import { routeControlMessage } from './control/router.js';

const input = { title: 'Reliable sign-in', intent: 'Customers can sign in reliably', repos: ['/repo'], reviewMerge: true };
const spec = (id, after = [], extra = {}) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', after, brief: `Implement ${id}`, ...extra });
const sessionSpec = (id, after = []) => ({ id, kind: 'session', title: `Run ${id}`, storyId: 'story', after, brief: `Do ${id} on this machine` });
const plan = (subs = [spec('api')], stories = [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in' }]) =>
  ({ context: 'The sign-in service is Java; deploys are Helm.', stories, subJobs: subs });
const PR_URL = 'https://github.com/org/repo/pull/1';
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
  let deploys = { expected: true, workflows: [{ name: 'Deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' }], summary: 'Deploys on merge · Deploy' };
  let comments = normaliseComments(resource(), 0);
  let status = () => null;
  const attributed = [], triaged = [], deployCalls = [];
  let verdict = async () => ({ tone: 'green', text: 'Reviewer approved.', liveSessionId: 'live-triage', error: false });
  const github = {
    async pr(s) { return { ...pr, url: s.pr.url }; }, async comments() { return comments; },
    async merge(s) { merged.push(s.pr.head); }, async deployment() { return deployment; },
    async deploys(s, observed) { deployCalls.push(observed.head); return { head: observed.head, base: observed.base, ...deploys }; },
  };
  const runner = new JobRunner({ store, runtime, github, now: () => clock, statusOf: (sid) => status(sid),
    summarise: async (c, p) => { triaged.push(c.fingerprint); return verdict(c, p); } });
  const job = store.create(jobInput);
  const tick = async () => { clock += 61000; await runner.tick(); };
  const last = () => launched.at(-1);
  const workerFor = (subId, phase) => launched.findLast((w) => w.sub?.id === subId && (!phase || w.run.phase === phase));
  const report = (payload, worker = last()) => store.report(worker.sid, worker.run.id, payload);
  const sub = (index = 0) => store.get(job.id).subJobs[index];
  async function approve(p = plan()) {
    store.action(job.id, 'start'); await tick(); report({ kind: 'plan', plan: p }); await tick();
    const current = store.get(job.id); store.approvePlan(job.id, current.revision); await tick();
  }
  return { store, job, runner, runtime, github, alive, launched, stopped, merged, cleaned, tick, last, workerFor, report, approve, sub,
    attributed, triaged, deployCalls, clockNow: () => clock,
    setPr: (value) => { pr = { ...pr, ...value }; }, setDeployment: (value) => { deployment = value; },
    setDeploys: (value) => { deploys = { ...deploys, ...value }; }, setStatus: (fn) => { status = fn; },
    setComments: (value) => { comments = normaliseComments(value, 0); }, setVerdict: (fn) => { verdict = fn; } };
}
const author = (login, bot = false) => ({ login, __typename: bot ? 'Bot' : 'User' });
const node = (id, login, body, at, extra = {}) => ({ id, author: author(login, extra.bot), body, createdAt: at, updatedAt: at, url: `${PR_URL}#${id}`, ...extra });
// A GraphQL `resource` payload in the shape COMMENTS_QUERY returns.
function resource({ comments = [], reviews = [], threads = [] } = {}) {
  return { author: { login: 'agent' }, comments: { nodes: comments }, reviews: { nodes: reviews },
    reviewThreads: { nodes: threads.map((t) => ({ id: t.id, isResolved: !!t.resolved, isOutdated: false, path: t.path || 'src/app.js', line: 4, comments: { nodes: t.comments } })) } };
}
// A sub-job at the PR stage, one session having done the whole implementation.
async function atPr(f, p = plan()) {
  f.store.update(f.job.id, (j) => { j.reviewMerge = false; });
  await f.approve(p);
  f.report({ kind: 'published', url: PR_URL });
}

test('store persists settings, plans and live claims across restart', async (t) => {
  const f = fixture(t); await f.approve();
  f.store.settings({ concurrency: 4 });
  assert.equal(f.store.snapshot().version, 2);
  assert.deepEqual(new JobStore(f.store.file).snapshot(), f.store.snapshot());
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1);
});

// --- Migration (version 1 -> 2) ---

const legacy = {
  version: 1,
  settings: { concurrency: 2, maxRepairs: 2, maxRunMinutes: 120, deploymentStaleMinutes: 30, paused: false },
  jobs: [{
    id: 'job_old', title: 'Old', intent: 'Old goal', stage: 'active', revision: 7, reviewCode: true, amendmentAuthority: 'auto',
    amendments: [{ id: 'amd_1', status: 'accepted' }], recoveryOf: { jobId: 'job_older', subJobId: 'api' },
    plan: { stories: [{ id: 'story', key: 'AUTH-1', title: 'Sign-in', value: 'Customers can sign in' }],
      subJobs: [{ id: 'api', title: 'Deliver api', repo: '/repo', storyId: 'story', dependsOn: [], instructions: 'x'.repeat(900), deployment: { verify: 'hit /health' } },
        { id: 'web', title: 'Deliver web', repo: '/repo', storyId: 'story', dependsOn: ['api'], instructions: 'Implement web' }] },
    subJobs: [{ id: 'api', title: 'Deliver api', repo: '/repo', storyId: 'story', dependsOn: [], instructions: 'x'.repeat(900),
      deployment: { verify: 'hit /health' }, stage: 'implementation', state: 'verified', jiraKey: 'AUTH-1',
      local: { commitMessage: 'AUTH-1: x', checks: ['Tests pass'] }, dependenciesVerified: true, codeApprovedAt: 5, recoveryJobId: 'job_r', recoveryReason: 'boom' }],
    runs: [{ id: 'run_1', subJobId: 'api', phase: 'publish', stopped: false, sessionId: 'sid', report: null }],
  }],
};

test('a version-1 file loads as version 2: after/brief replace dependsOn/instructions and every removed field is gone', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-v1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new JobStore(file);
  const job = store.get('job_old');
  assert.equal(store.snapshot().version, 2);
  assert.equal(store.snapshot().settings.maxRunMinutes, undefined);
  for (const key of ['reviewCode', 'amendmentAuthority', 'amendments', 'recoveryOf']) assert.equal(job[key], undefined, key);
  assert.equal(job.plan.context, '', 'a legacy plan has no context; the schema only requires one of a new plan');
  assert.equal(job.plan.stories[0].value, undefined);
  const [api, web] = job.plan.subJobs;
  assert.deepEqual(web.after, ['api']); assert.equal(web.dependsOn, undefined);
  assert.equal(api.brief.length, 900, 'legacy text over the new cap is kept, never truncated');
  for (const key of ['instructions', 'deployment', 'check']) assert.equal(api[key], undefined, key);
  const liveApi = job.subJobs[0];
  assert.equal(liveApi.state, 'queued', 'it had a local receipt and was waiting to publish: one session now does both');
  for (const key of ['local', 'dependenciesVerified', 'codeApprovedAt', 'recoveryJobId', 'recoveryReason']) assert.equal(liveApi[key], undefined, key);
  // The file itself is untouched until the next ordinary write.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  store.action('job_old', 'pause');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  assert.throws(() => migrateJobs({ version: 3, jobs: [] }), /refusing to discard jobs/);
  assert.throws(() => migrateJobs({ version: 1, jobs: {} }), /refusing to discard jobs/);
  assert.deepEqual(migrateJobs(structuredClone(migrateJobs(legacy))), migrateJobs(legacy), 'migration is idempotent');
});

test('a legacy publish run can still land its receipt on the migrated job', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-jobs-v1b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new JobStore(file);
  store.report('sid', 'run_1', { kind: 'published', url: PR_URL });
  assert.equal(store.get('job_old').subJobs[0].stage, 'pr');
});

// --- Plan schema ---

test('a new plan needs context, briefs stay short, and checks belong to PRs only', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const before = f.store.snapshot();
  const { context, ...contextless } = plan();
  assert.throws(() => f.report({ kind: 'plan', plan: contextless }), /context/i);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', [], { brief: 'x'.repeat(501) })]) }));
  assert.throws(() => f.report({ kind: 'plan', plan: plan([sessionSpec('a')].map((s) => ({ ...s, check: 'curl it' }))) }), /own check/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', ['b']), spec('b', ['a'])]) }), /cycles/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([spec('a', ['ghost'])]) }), /Unknown dependency/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), storyId: 'ghost' }]) }), /Unknown story/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...sessionSpec('a'), repo: '/repo' }]) }), /session sub-job has no repo/);
  assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), repo: undefined }]) }), /PR sub-job needs repo/);
  for (const repo of ['service', 'https://github.com/org/repo', '/repo\n/other']) {
    assert.throws(() => f.report({ kind: 'plan', plan: plan([{ ...spec('a'), repo }]) }), /local repository path/);
  }
  assert.deepEqual(f.store.snapshot(), before, 'a rejected plan persists nothing');
  f.report({ kind: 'plan', plan: plan([spec('api', [], { check: 'Sign-in works in dev' }), sessionSpec('spike')],
    [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in', value: 'dropped' }]) });
  const stored = f.store.get(f.job.id).plan;
  assert.equal(stored.stories[0].value, undefined, 'a story is a title, not a value statement');
  assert.equal(stored.subJobs[0].check, 'Sign-in works in dev');
  assert.equal(stored.context, plan().context);
});

test('plan approval is explicit and rejects a stale or running review', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan() });
  assert.throws(() => f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision), /not ready/);
  await f.tick();
  const rev = f.store.get(f.job.id).revision;
  f.store.action(f.job.id, 'pause');
  assert.throws(() => f.store.approvePlan(f.job.id, rev), /changed/);
});

test('jobs without repository hints discover and persist repositories before human approval', async (t) => {
  const { repos, ...withoutRepos } = input;
  const f = fixture(t, withoutRepos);
  assert.deepEqual(f.job.repos, []);
  f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api'), { ...spec('web'), repo: '/web' }, spec('api-followup', ['api'])]) }); await f.tick();
  const current = new JobStore(f.store.file).get(f.job.id);
  assert.deepEqual(current.repos, ['/repo', '/web']);
  assert.equal(current.stage, 'planning'); assert.deepEqual(current.subJobs, []);
  assert.equal(f.launched.length, 1, 'discovery must wait for plan approval');
  f.store.approvePlan(f.job.id, current.revision); await f.tick();
  assert.deepEqual(f.launched.slice(1).map((w) => w.sub.repo), ['/repo', '/web']);
});

test('a replan keeps the previous plan and an edited plan replaces the proposed repositories', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([{ ...spec('api'), repo: '/discovered' }]) }); await f.tick();
  const first = f.store.get(f.job.id);
  f.store.action(f.job.id, 'replan', { feedback: 'Move this change to the shared service' }); await f.tick();
  assert.deepEqual(f.last().job.previousPlan, first.plan);
  f.report({ kind: 'plan', plan: plan([{ ...spec('api'), repo: '/shared' }]) }); await f.tick();
  assert.throws(() => f.store.approvePlan(f.job.id, first.revision), /changed/);
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision, plan([{ ...spec('api'), repo: '/reviewed' }]));
  assert.deepEqual(f.store.get(f.job.id).repos, ['/reviewed']);
  assert.equal(f.sub().repo, '/reviewed');
});

test('reports require the assigned caller and the phase they were launched for', async (t) => {
  const f = fixture(t); await f.approve();
  const w = f.last();
  assert.equal(w.run.phase, 'implementation');
  assert.throws(() => f.store.report('someone-else', w.run.id, { kind: 'published', url: PR_URL }), /assigned/);
  assert.throws(() => f.report({ kind: 'deployed', checks: ['Works'] }), /must submit published/);
  assert.throws(() => f.report({ kind: 'published', url: 'https://example.com/pull/1' }));
  assert.throws(() => f.report({ kind: 'blocked', summary: 'x', amendment: { reason: 'r', ops: [] } }), /amendment/, 'the plan is the human\'s: no receipt may carry a change to it');
  assert.throws(() => f.report({ kind: 'blocked', summary: 'x', move: 'invent-a-move' }));
  f.report({ kind: 'published', url: PR_URL });
  f.report({ kind: 'published', url: PR_URL }, w);
  assert.throws(() => f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/2' }, w), /different report/);
});

// --- One session per PR ---

test('one session works, commits, pushes and opens the PR: no publish phase, and a PR dependency gates the merge, not the launch', async (t) => {
  const f = fixture(t); f.store.update(f.job.id, (j) => { j.reviewMerge = false; });
  await f.approve(plan([spec('api'), spec('web', ['api'])]));
  assert.deepEqual(f.launched.slice(1).map((w) => [w.sub.id, w.run.phase]), [['api', 'implementation'], ['web', 'implementation']],
    'both build in parallel: a PR prerequisite means deploy-after');
  f.report({ kind: 'published', url: 'https://github.com/org/repo/pull/2' }, f.workerFor('web'));
  assert.ok(f.sub(1).nextPollAt > Date.now() + 9000, 'a fresh PR settles before the first observation');
  await f.tick();
  const web = f.sub(1);
  assert.equal(web.stage, 'pr'); assert.equal(web.state, 'watching');
  assert.equal(f.launched.filter((w) => w.run.phase === 'publish').length, 0);
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.deepEqual(f.merged, [], 'api has not deployed yet');
  f.store.update(f.job.id, (j) => { j.subJobs[0].deployed = { checks: ['Live'] }; j.subJobs[0].stage = 'done'; });
  await f.tick(); assert.deepEqual(f.merged, ['head1']);
});

test('a session sub-job is a hard prerequisite: nothing behind it starts until its receipt is approved', async (t) => {
  const f = fixture(t);
  await f.approve(plan([sessionSpec('spike'), spec('api', ['spike'])]));
  assert.deepEqual(f.launched.slice(1).map((w) => [w.sub.id, w.run.phase]), [['spike', 'session']]);
  assert.throws(() => f.report({ kind: 'published', url: PR_URL }), /must submit completed/);
  f.report({ kind: 'completed', checks: ['Schema documented in task memory'] }); await f.tick();
  assert.equal(f.sub().stage, 'review');
  assert.equal(f.launched.length, 2, 'nothing starts while the session result awaits review');
  f.store.action(f.job.id, 'approve-session', { subJobId: 'spike', sessionReceiptId: f.sub().result.receiptId });
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api', 'implementation']);
});

// --- PR stage ---

test('whether a merge deploys is inferred once per head and again after a new one', async (t) => {
  const f = fixture(t); await atPr(f); await f.tick();
  assert.deepEqual(f.deployCalls, ['head1']);
  assert.equal(f.sub().deploys.summary, 'Deploys on merge · Deploy');
  await f.tick(); assert.deepEqual(f.deployCalls, ['head1'], 'the same head is not re-read');
  f.setPr({ head: 'head2' }); await f.tick();
  assert.deepEqual(f.deployCalls, ['head1', 'head2']);
  // A failed inference is an observation error like any other poll's.
  f.github.deploys = async () => { throw new Error('gh unavailable'); };
  f.setPr({ head: 'head3' }); await f.tick();
  assert.match(f.sub().observationError, /unavailable/); assert.equal(f.sub().pr.head, 'head2');
});

test('a merge that starts nothing IS the delivery: no post-merge watch and no verify session', async (t) => {
  const f = fixture(t);
  f.setDeploys({ expected: false, summary: 'Merge completes it · deployment-pipeline ignores **.md' });
  f.store.update(f.job.id, (j) => { j.reviewMerge = false; });
  await f.approve(plan([spec('docs'), spec('api', ['docs'])]));
  f.report({ kind: 'published', url: PR_URL }, f.workerFor('docs'));
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  const docs = f.sub();
  assert.equal(docs.stage, 'cleanup'); assert.equal(docs.deployed.commit, 'merge1'); assert.ok(docs.mergedAt);
  assert.deepEqual(docs.deployed.checks, [MERGE_IS_DELIVERY]);
  assert.equal(f.launched.some((w) => w.run.phase === 'verify'), false);
  await f.tick(); assert.deepEqual(f.cleaned, ['docs']);
  assert.equal(f.launched.filter((w) => w.sub?.id === 'api' && w.run.phase === 'implementation').length, 1);
});

test('a merge that deploys is watched, and passing post-merge runs finish it without a session unless the plan named a check', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.sub().stage, 'deployment');
  f.setDeployment({ status: 'passing', runs: [{ workflow: 'Deploy', status: 'passing' }], commit: 'merge1' });
  await f.tick();
  assert.equal(f.launched.some((w) => w.run.phase === 'verify'), false, 'nothing to confirm by hand');
  assert.equal(f.sub().stage, 'cleanup'); assert.deepEqual(f.sub().deployed.checks, ['Post-merge runs passed']);
  await f.tick(); assert.equal(f.store.get(f.job.id).stage, 'done');

  const g = fixture(t); await atPr(g, plan([spec('api', [], { check: 'helm list shows auth in dev and prod' })]));
  g.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await g.tick();
  g.setDeployment({ status: 'passing', runs: [{ workflow: 'Deploy', status: 'passing' }], commit: 'merge1' });
  await g.tick();
  assert.equal(g.last().run.phase, 'verify');
  g.report({ kind: 'deployed', checks: ['helm shows auth 1.4.0 in both'] }); await g.tick();
  assert.equal(g.sub().stage, 'done'); assert.deepEqual(g.cleaned, ['api']);
});

test('a failing post-merge run names the workflow and creates no second job', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy to prod', status: 'failing' }, { workflow: 'Scan', status: 'passing' }], commit: 'merge1' });
  await f.tick();
  assert.equal(f.sub().error, 'Post-merge run failed: Deploy to prod');
  assert.equal(f.sub().stage, 'deployment');
  assert.equal(f.store.snapshot().jobs.length, 1, 'the fix is a move on this job, never a recovery job');
  assert.equal(f.sub().deployed, undefined);
});

test('a closed PR blocks the sub-job', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setPr({ state: 'CLOSED' }); await f.tick();
  assert.equal(f.sub().error, 'PR was closed without merging');
});

test('failed CI wakes only bounded repair sessions, and the limit is an error the human retries', async (t) => {
  const f = fixture(t); f.store.settings({ maxRepairs: 1 }); await atPr(f);
  f.setPr({ checkStatus: 'failing' }); await f.tick(); assert.equal(f.last().run.phase, 'repair');
  await f.tick(); assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 1);
  f.report({ kind: 'repaired', changes: ['Fixed flaky clock assertion'], checks: ['Clock test passes'] }); await f.tick();
  assert.equal(f.sub().repairs.length, 1); assert.match(f.sub().error, /limit reached/);
  f.store.action(f.job.id, 'retry', { subJobId: 'api' }); await f.tick();
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 2);
});

test('a merged sub-job with nothing deployed past the stale window is flagged; a slow run in progress is not', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.ok(f.sub().mergedAt);
  f.setDeployment({ status: 'pending', runs: [], commit: 'merge1' });
  await f.tick(); assert.equal(f.sub().deploymentStale, null, 'inside the window it is just waiting');
  for (let i = 0; i < 30; i++) await f.tick();
  assert.equal(f.sub().deploymentStale.since, f.sub().mergedAt);
  assert.ok(!f.sub().error, 'advisory: polling continues and nothing is blocked');
  f.setDeployment({ status: 'pending', runs: [{ workflow: 'Deploy', runId: 7, status: 'skipped' }], commit: 'merge1' });
  await f.tick(); assert.ok(f.sub().deploymentStale, 'an all-skipped merge deployed nothing');
  f.setDeployment({ status: 'pending', runs: [{ workflow: 'Deploy', runId: 7, status: 'pending' }], commit: 'merge1' });
  await f.tick(); assert.equal(f.sub().deploymentStale, null, 'a run in progress is a slow deploy, never stale');
});

// --- Moves ---

const movesOf = (f) => f.store.get(f.job.id).moves;

test('Fix here on an open PR launches a repair whatever colour the checks are, and the repaired receipt clears it', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'published', url: PR_URL }); await f.tick();
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.equal(f.launched.filter((w) => w.run.phase === 'repair').length, 0, 'green checks start nothing on their own');
  f.store.action(f.job.id, 'fix-here', { subJobId: 'api', note: 'Rename the flag to sign_in_v2' });
  const requested = f.sub();
  assert.equal(requested.fixRequested.note, 'Rename the flag to sign_in_v2');
  assert.equal(requested.state, 'watching'); assert.equal(requested.nextPollAt, 0);
  await f.tick();
  assert.equal(f.last().run.phase, 'repair');
  assert.equal(f.last().sub.fixRequested.note, 'Rename the flag to sign_in_v2', 'the prompt carries the note');
  f.report({ kind: 'repaired', changes: ['Renamed the flag'], checks: ['Tests pass'] });
  assert.equal(f.sub().fixRequested, null); assert.equal(f.sub().note, null);
  assert.deepEqual(movesOf(f).map((m) => [m.subJobId, m.move, m.note]), [['api', 'fix-here', 'Rename the flag to sign_in_v2']]);
  assert.match(movesOf(f)[0].detail, /new commit on “Deliver api”/);
  assert.match(movesOf(f)[0].id, /^mv_/);
});

test('Fix here before a PR exists is a retry with a steer, and is refused once the PR has merged', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'blocked', summary: 'The feature flag name is ambiguous', move: 'fix-here' }); await f.tick();
  assert.deepEqual(f.sub().blocked, { summary: 'The feature flag name is ambiguous', move: 'fix-here', phase: 'implementation', at: f.sub().blocked.at });
  assert.equal(f.sub().error, 'The feature flag name is ambiguous');
  f.store.action(f.job.id, 'fix-here', { subJobId: 'api', note: 'Call it sign_in_v2' });
  assert.equal(f.sub().error, null); assert.equal(f.sub().blocked, null);
  assert.equal(f.sub().state, 'queued'); assert.equal(f.sub().note, 'Call it sign_in_v2');
  await f.tick();
  assert.equal(f.last().sub.note, 'Call it sign_in_v2');
  f.report({ kind: 'published', url: PR_URL });
  assert.equal(f.sub().note, null, 'the note is spent once that session reports');
  f.store.update(f.job.id, (j) => { j.subJobs[0].stage = 'deployment'; });
  assert.throws(() => f.store.action(f.job.id, 'fix-here', { subJobId: 'api' }), /Split out/);
});

test('Split out adds a PR on the same ticket, before or after this one', async (t) => {
  for (const position of ['before', 'after']) {
    const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
    f.store.action(f.job.id, 'split-out', { subJobId: 'api', title: 'Sync the proto', brief: 'Regenerate the proto', position, check: 'Proto matches', note: 'Do this one first' });
    const job = f.store.get(f.job.id);
    const [api, extra] = job.subJobs;
    assert.equal(extra.id, 'api-2'); assert.equal(extra.repo, '/repo'); assert.equal(extra.storyId, 'story');
    assert.equal(extra.jiraKey, 'AUTH-123'); assert.equal(extra.check, 'Proto matches'); assert.equal(extra.stage, 'implementation');
    assert.deepEqual(job.plan.subJobs.map((s) => s.id), ['api', 'api-2'], 'the approved plan carries it too');
    if (position === 'before') { assert.deepEqual(api.after, ['api-2']); assert.deepEqual(extra.after, []); }
    else { assert.deepEqual(api.after, []); assert.deepEqual(extra.after, ['api']); }
    assert.deepEqual(job.plan.subJobs[0].after, api.after);
    assert.equal(api.note, 'Do this one first'); assert.equal(api.repairAllowance, 1);
    assert.match(movesOf(f)[0].detail, new RegExp(`Split out “Sync the proto” to land ${position} this`));
  }
});

test('Split out from a merged sub-job is its fix: it counts as deployed when the fix does', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  f.setDeployment({ status: 'failing', runs: [{ workflow: 'Deploy', status: 'failing' }], commit: 'merge1' }); await f.tick();
  assert.match(f.sub().error, /Post-merge run failed/);
  f.store.action(f.job.id, 'split-out', { subJobId: 'api', title: 'Guard empty payloads', brief: 'Add the null guard', position: 'before' });
  const api = f.sub();
  assert.equal(api.recoveredBy, 'api-2'); assert.equal(api.state, 'awaiting-fix'); assert.equal(api.error, null);
  assert.deepEqual(api.after, [], 'a merged sub-job cannot wait for anything: position is ignored');
  assert.match(movesOf(f)[0].detail, /as the fix for this merged PR/);
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api-2', 'implementation']);
  f.store.update(f.job.id, (j) => { j.subJobs[1].deployed = { checks: ['Live'] }; j.subJobs[1].stage = 'done'; });
  await f.tick();
  assert.equal(f.sub().stage, 'cleanup'); assert.match(f.sub().deployed.checks[0], /Fixed by Guard empty payloads/);
  assert.equal(f.sub().deployed.commit, 'merge1');
});

test('New ticket adds a keyless story, which a Jira run keys while the job is active before its PR can start', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  f.store.action(f.job.id, 'new-ticket', { subJobId: 'api', storyTitle: 'Sign-ins are audited', project: 'SEC',
    title: 'Emit audit events', brief: 'Emit an event per sign-in', position: 'after' });
  let job = f.store.get(f.job.id);
  assert.deepEqual(job.plan.stories.map((s) => [s.id, s.key ?? null, s.project ?? null]), [['story', 'AUTH-123', null], ['s-2', null, 'SEC']]);
  const extra = job.subJobs[1];
  assert.equal(extra.storyId, 's-2'); assert.equal(extra.jiraKey, null); assert.deepEqual(extra.after, ['api']);
  await f.tick();
  const ticketing = f.launched.findLast((w) => w.run.phase === 'jira');
  assert.equal(ticketing.sub, null, 'the same ticketing step, run again');
  assert.equal(f.launched.filter((w) => w.sub?.id === 'api-2').length, 0, 'nothing starts without a key');
  f.report({ kind: 'jira', stories: [{ id: 's-2', key: 'SEC-42' }] }, ticketing);
  job = f.store.get(f.job.id);
  assert.equal(job.stage, 'active', 'an active job is not sent back through the Jira column');
  assert.equal(job.subJobs[1].jiraKey, 'SEC-42'); assert.equal(job.plan.subJobs[1].jiraKey, 'SEC-42');
  await f.tick();
  assert.deepEqual([f.last().sub.id, f.last().run.phase], ['api-2', 'implementation']);
  assert.match(movesOf(f)[0].detail, /New ticket “Sign-ins are audited” with PR “Emit audit events” to land after this/);
});

test('Reorder rewrites what a sub-job lands after, refusing itself, a stranger and a cycle', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')])); f.alive.clear(); await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['web'] }), /cannot depend on itself/);
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['ghost'] }), /Unknown dependency/);
  f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['api'] });
  assert.deepEqual(f.sub(1).after, ['api']); assert.deepEqual(f.store.get(f.job.id).plan.subJobs[1].after, ['api']);
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'api', after: ['web'] }), /cycles/);
  assert.deepEqual(f.sub().after, [], 'a refused reorder changes nothing');
  f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: [] });
  assert.equal(movesOf(f).at(-1).detail, 'No longer waits for anything');
  f.store.update(f.job.id, (j) => { j.subJobs[1].stage = 'deployment'; });
  assert.throws(() => f.store.action(f.job.id, 'reorder', { subJobId: 'web', after: ['api'] }), /has merged/);
});

test('Mark position: a PR opened by hand, a merge done by hand, and work already covered elsewhere', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'merged' }), /Only an open PR/);
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'pr' }), /Give the PR url/);
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'pr', url: PR_URL });
  let api = f.sub();
  assert.equal(api.stage, 'pr'); assert.equal(api.state, 'watching'); assert.equal(api.pr.url, PR_URL);
  assert.ok(api.nextPollAt > Date.now() + 9000, 'a PR named by hand settles like a reported one');
  assert.throws(() => f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'pr', url: PR_URL }), /already has a PR/);
  f.store.update(f.job.id, (j) => { j.subJobs[0].error = 'stuck'; });
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'merged' });
  api = f.sub();
  assert.equal(api.error, null); assert.equal(api.nextPollAt, 0); assert.equal(api.stage, 'pr', 'the next poll reads the merge itself');
  f.setPr({ state: 'MERGED', mergeCommit: 'merge1' }); await f.tick();
  assert.equal(f.sub().stage, 'deployment');
  f.store.action(f.job.id, 'mark', { subJobId: 'api', position: 'done', note: 'Deployed by hand, /health is green' });
  api = f.sub();
  assert.equal(api.stage, 'cleanup'); assert.deepEqual(api.deployed.checks, ['Deployed by hand, /health is green']);
  assert.equal(api.deployed.commit, 'merge1'); assert.equal(api.note, null, 'a mark note is history, not a steer for a next session');
  await f.tick(); assert.equal(f.store.get(f.job.id).stage, 'done');
  assert.deepEqual(movesOf(f).map((m) => m.move), ['mark', 'mark', 'mark']);
});

test('Mark done finishes a session sub-job with its own receipt', async (t) => {
  const f = fixture(t); await f.approve(plan([sessionSpec('spike')])); f.alive.clear(); await f.tick();
  f.store.action(f.job.id, 'mark', { subJobId: 'spike', position: 'done', note: 'Already answered in the incident review' });
  const spike = f.sub();
  assert.equal(spike.stage, 'cleanup');
  assert.deepEqual(spike.result, { checks: ['Already answered in the incident review'], at: spike.result.at, receiptId: null });
  assert.equal(spike.deployed, undefined);
});

test('Drop is the old cancel under a new name: it stops the live step and ignores its late receipt', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web', ['api'])]));
  const worker = f.workerFor('api');
  f.store.action(f.job.id, 'drop', { subJobId: 'api' });
  let api = f.sub();
  assert.equal(api.stage, 'cleanup'); assert.ok(api.cancelledAt); assert.equal(api.state, 'cancelled');
  f.report({ kind: 'published', url: PR_URL }, worker);
  assert.equal(f.sub().pr, null, 'a racing receipt must not move a dropped sub-job');
  await f.tick();
  assert.ok(f.stopped.includes(worker.run.id)); assert.deepEqual(f.cleaned, ['api']);
  assert.equal(f.sub().stage, 'done');
  assert.throws(() => f.store.action(f.job.id, 'drop', { subJobId: 'api' }), /already finished/);
  assert.throws(() => f.store.action(f.job.id, 'cancel', { subJobId: 'api' }), /already finished/, 'the old name still routes here');
  assert.throws(() => f.store.action(f.job.id, 'drop'), /Choose a sub-job/);
  assert.deepEqual(movesOf(f).map((m) => m.move), ['drop']);
});

test('a move that rewrites the plan waits for the session working to it; Drop never does', async (t) => {
  const f = fixture(t); await f.approve();
  for (const [action, payload] of [
    ['split-out', { title: 'Second PR', brief: 'Split it' }],
    ['new-ticket', { storyTitle: 'Another story', title: 'Second PR', brief: 'Split it' }],
    ['reorder', { after: [] }],
    ['mark', { position: 'done' }],
  ]) assert.throws(() => f.store.action(f.job.id, action, { subJobId: 'api', ...payload }), /Wait for the session to stop/, action);
  assert.deepEqual(movesOf(f), []);
  f.store.action(f.job.id, 'drop', { subJobId: 'api' });
  assert.equal(f.sub().state, 'cancelled');
});

test('every move is refused on a finished or dropped sub-job', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  f.store.action(f.job.id, 'drop', { subJobId: 'api' });
  for (const action of ['fix-here', 'split-out', 'new-ticket', 'reorder', 'drop', 'mark']) {
    assert.throws(() => f.store.action(f.job.id, action, { subJobId: 'api', title: 't', brief: 'b', storyTitle: 's', after: [], position: 'done' }), /already finished/, action);
  }
});

// --- Settle ---

test('a long step is never killed by a clock, but one that stops working without a receipt is an error', async (t) => {
  const f = fixture(t); f.setStatus(() => 'working');
  await f.approve();
  for (let i = 0; i < 40; i++) await f.tick();
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1, 'no time limit');
  assert.equal(f.sub().error, undefined);
  f.setStatus(() => 'needs-you');
  for (let i = 0; i < 20; i++) await f.tick();
  assert.equal(f.sub().error, undefined, 'waiting on a human is surfaced on the board, never ended here');
  f.setStatus(() => 'idle');
  await f.tick();
  const idleAt = f.store.get(f.job.id).runs[1].idleSince;
  assert.ok(idleAt);
  f.setStatus(() => 'working'); await f.tick();
  assert.equal(f.store.get(f.job.id).runs[1].idleSince, null, 'working again clears it');
  f.setStatus(() => 'idle');
  await f.tick();
  while (f.clockNow() - f.store.get(f.job.id).runs[1].idleSince <= IDLE_RECEIPT_GRACE_MS) await f.tick();
  await f.tick();
  assert.match(f.sub().error, /finished without a receipt/);
  assert.equal(f.store.get(f.job.id).runs[1].stopped, true);
});

test('crashed and uncertain launches are blocked, not silently duplicated on restart', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  assert.match(f.sub().error, /stopped without a receipt/);
  const other = f.store.create(input); f.store.action(other.id, 'start'); f.store.claim(other.id, null, 'planning');
  await f.tick(); assert.match(f.store.get(other.id).error, /Launch was interrupted/);
});

test('a receipt arriving during an exit probe is honoured without a false missing-receipt error', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.runtime.isAlive = async () => { f.report({ kind: 'plan', plan: plan() }); return false; };
  await f.tick();
  const job = f.store.get(f.job.id);
  assert.equal(job.error, undefined); assert.ok(job.plan); assert.equal(job.runs[0].stopped, true);
});

test('a failed liveness query does not stop the worker or release its slot', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.runtime.isAlive = async () => { throw new Error('tmux temporarily unavailable'); };
  await f.tick();
  assert.equal(f.stopped.length, 0); assert.equal(f.store.get(f.job.id).runs[0].stopped, false);
});

test('session teardown failure keeps its slot reserved', async (t) => {
  const f = fixture(t); await f.approve(); f.report({ kind: 'published', url: PR_URL });
  f.runtime.stop = async () => { throw new Error('Still alive'); }; await f.tick();
  assert.equal(f.store.get(f.job.id).runs.filter((r) => !r.stopped).length, 1);
  assert.match(f.store.get(f.job.id).error, /Still alive/);
});

test('cleanup refusal remains visible and retryable', async (t) => {
  const f = fixture(t); await f.approve();
  f.alive.clear(); await f.tick();
  f.store.update(f.job.id, (j) => { const s = j.subJobs[0]; s.error = null; s.stage = 'cleanup'; s.deployed = { checks: ['Works'] }; });
  f.runtime.cleanup = async () => { throw new Error('Worktree contains local changes'); };
  await f.tick();
  assert.equal(f.sub().stage, 'cleanup'); assert.match(f.sub().error, /local changes/);
});

test('concurrency applies to all jobs and paused work never starts a session', async (t) => {
  const f = fixture(t); f.store.settings({ concurrency: 1 });
  const second = f.store.create(input); f.store.action(f.job.id, 'start'); f.store.action(second.id, 'start');
  await f.tick(); await f.tick(); assert.equal(f.launched.length, 1);
  f.store.settings({ paused: true }); f.report({ kind: 'plan', plan: plan() }); await f.tick();
  assert.equal(f.launched.length, 1); assert.equal(f.alive.size, 0);
  f.store.settings({ paused: false }); await f.tick(); assert.equal(f.launched.length, 2);
});

test('idle ticks and exhausted claims do not rewrite state or trigger extra graph rebuilds', async (t) => {
  const f = fixture(t); let rebuilt = 0; f.runner.onChange = async () => { rebuilt++; };
  const before = f.store.data; await f.tick(); assert.equal(rebuilt, 0); assert.equal(f.store.data, before);
  f.store.action(f.job.id, 'start'); await f.tick(); assert.equal(rebuilt, 1);
  const running = f.store.data; assert.equal(f.store.claim(f.job.id, null, 'planning'), null); assert.equal(f.store.data, running);
  await f.tick(); assert.equal(rebuilt, 1);
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
  await f.tick(); assert.equal(f.merged.length, 0); assert.match(f.sub().observationError, /unavailable/);
});

// --- Jira ---

test('approving a plan with proposed stories runs a Jira step whose keys, and only those, unlock implementation', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  const proposed = plan([spec('api'), { ...spec('web'), storyId: 'audit' }],
    [{ id: 'story', key: 'AUTH-123', title: 'Reliable sign-in' }, { id: 'audit', project: 'SEC', title: 'Sign-ins are audited' }]);
  f.report({ kind: 'plan', plan: proposed }); await f.tick();
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision); await f.tick();
  let job = f.store.get(f.job.id);
  assert.equal(job.stage, 'jira'); assert.deepEqual(job.subJobs, [], 'no worktree or implementation before the tickets exist');
  assert.equal(f.last().run.phase, 'jira'); assert.equal(f.last().sub, null);
  assert.throws(() => f.report({ kind: 'jira', stories: [{ id: 'nope', key: 'SEC-1' }] }), /Unknown story/);
  assert.throws(() => f.report({ kind: 'jira', stories: [{ id: 'story', key: 'AUTH-999' }] }), /approved as AUTH-123/);
  assert.throws(() => f.report({ kind: 'jira', stories: [{ id: 'story', key: 'AUTH-123' }] }), /still missing: audit/);
  assert.equal(f.store.get(f.job.id).stage, 'jira', 'a rejected receipt changes nothing');
  f.report({ kind: 'jira', stories: [{ id: 'audit', key: 'SEC-42' }] });
  job = f.store.get(f.job.id);
  assert.equal(job.stage, 'active');
  assert.deepEqual(job.subJobs.map((s) => s.jiraKey), ['AUTH-123', 'SEC-42']);
  await f.tick();
  assert.deepEqual(f.launched.slice(2).map((w) => [w.run.phase, w.sub.id]), [['implementation', 'api'], ['implementation', 'web']]);
  assert.ok(f.stopped.includes(f.launched[1].run.id), 'the ticketing session is released like planning');
});

test('a blocked Jira step is retryable from the same column and a fully keyed plan skips it', async (t) => {
  const f = fixture(t); f.store.action(f.job.id, 'start'); await f.tick();
  f.report({ kind: 'plan', plan: plan([spec('api')], [{ id: 'story', title: 'Reliable sign-in' }]) }); await f.tick();
  f.store.approvePlan(f.job.id, f.store.get(f.job.id).revision); await f.tick();
  f.report({ kind: 'blocked', summary: 'Jira search failed: 401 from the Atlassian MCP' }); await f.tick();
  let job = f.store.get(f.job.id);
  assert.equal(job.stage, 'jira'); assert.match(job.error, /401/); assert.equal(job.blocked.phase, 'jira');
  f.store.action(f.job.id, 'retry'); await f.tick();
  assert.equal(f.last().run.phase, 'jira');
  f.report({ kind: 'jira', stories: [{ id: 'story', key: 'AUTH-7' }] }); await f.tick();
  assert.equal(f.store.get(f.job.id).stage, 'active'); assert.equal(f.sub().jiraKey, 'AUTH-7');
  const g = fixture(t); await g.approve();
  assert.deepEqual(g.launched.map((w) => w.run.phase), ['planning', 'implementation'], 'existing keys mean nothing to write in Jira');
});

test('a plan carries no branch names: only the renaming session\'s own sub-job follows', async (t) => {
  const f = fixture(t); await f.approve(plan([spec('api'), spec('web')]));
  const [api, web] = f.launched.slice(1);
  assert.equal(f.sub().worktree.branch, 'branch-api', 'launched on the placeholder');
  assert.equal(f.store.noteBranchRename('session-nobody', 'fix/AUTH-123-x'), false);
  assert.equal(f.store.noteBranchRename(api.sid, 'fix/AUTH-123-reliable-sign-in'), true);
  const job = f.store.get(f.job.id);
  assert.deepEqual(job.subJobs.map((s) => s.worktree.branch), ['fix/AUTH-123-reliable-sign-in', 'branch-web']);
  assert.equal(job.subJobs[0].worktree.path, '/worktree/api');
  assert.equal(f.store.noteBranchRename(web.sid, 'fix/AUTH-123-web'), true);
});

// --- Comments ---

test('PR comments are read with every poll, triaged once per comment set and shaded on the sub-job', async (t) => {
  const f = fixture(t); await atPr(f);
  await f.tick(); await f.runner.idle();
  assert.equal(f.sub().prComments.items.length, 0); assert.equal(f.sub().commentSummary, null); assert.deepEqual(f.triaged, []);
  f.setComments(resource({ reviews: [{ ...node('r1', 'alice', 'Looks good', '2026-09-08T10:00:00Z'), state: 'APPROVED', submittedAt: '2026-09-08T10:00:00Z' }],
    comments: [node('c1', 'coverage-bot', 'Coverage 91%', '2026-09-08T10:00:05Z', { bot: true })] }));
  await f.tick(); await f.runner.idle();
  const sub = f.sub();
  assert.equal(sub.prComments.items.length, 2); assert.equal(sub.prComments.items[1].bot, true);
  assert.equal(sub.commentSummary.tone, 'green'); assert.equal(sub.commentSummary.fingerprint, sub.prComments.fingerprint);
  assert.deepEqual(f.attributed, ['live-triage'], 'the triage spend is billed to the sub-job session');
  await f.tick(); await f.runner.idle();
  assert.equal(f.triaged.length, 1, 'an unchanged comment set is not re-triaged');
});

test('a red verdict holds automatic merging until the head is approved; amber and green merge', async (t) => {
  const thread = (resolved) => resource({ threads: [{ id: 't1', resolved, comments: [node('tc1', 'bob', 'This drops the auth check; do not merge', '2026-09-08T10:00:00Z')] }] });
  for (const tone of ['red', 'amber', 'green']) {
    const f = fixture(t); await atPr(f);
    f.setVerdict(async () => ({ tone, text: `${tone} verdict`, liveSessionId: `live-${tone}` }));
    f.setComments(thread(false)); f.setPr({ checkStatus: 'passing' });
    await f.tick(); assert.equal(f.merged.length, 0, `${tone}: the verdict is still being written on the first poll`);
    await f.runner.idle(); await f.tick();
    assert.equal(commentsBlockMerge(f.sub()), tone === 'red');
    assert.equal(f.merged.length, tone === 'red' ? 0 : 1, tone);
    if (tone !== 'red') continue;
    f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
    await f.tick(); assert.deepEqual(f.merged, ['head1'], 'an explicit approval overrides the hold');
  }
});

test('a failed triage is an amber unavailable verdict that never blocks merging', async (t) => {
  const f = fixture(t); await atPr(f);
  f.setVerdict(async () => { throw new Error('claude exited 1'); });
  f.setComments(resource({ comments: [node('c1', 'alice', 'Question?', '2026-09-08T10:00:00Z')] })); f.setPr({ checkStatus: 'passing' });
  await f.tick(); await f.runner.idle();
  const sub = f.sub();
  assert.equal(sub.commentSummary.tone, 'amber'); assert.equal(sub.commentSummary.error, true); assert.match(sub.commentSummary.text, /unavailable/);
  await f.tick(); assert.deepEqual(f.merged, ['head1']);
});

test('a comments read failure is an observation error that keeps the previous PR evidence', async (t) => {
  const f = fixture(t); await atPr(f); f.setPr({ checkStatus: 'passing' });
  f.store.update(f.job.id, (j) => { j.reviewMerge = true; });
  await f.tick(); assert.equal(f.sub().pr.head, 'head1');
  f.github.comments = async () => { throw new Error('GraphQL rate limited'); };
  await f.tick();
  assert.match(f.sub().observationError, /rate limited/); assert.equal(f.sub().pr.head, 'head1'); assert.equal(f.merged.length, 0);
});

test('manual merge approval is bound to the exact head a push invalidates', async (t) => {
  const f = fixture(t); await f.approve();
  f.report({ kind: 'published', url: PR_URL });
  f.setPr({ checkStatus: 'passing' }); await f.tick();
  assert.throws(() => f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'older' }), /green/);
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head1' });
  f.setPr({ head: 'head2' }); await f.tick(); assert.equal(f.merged.length, 0);
  f.store.action(f.job.id, 'approve-merge', { subJobId: 'api', head: 'head2' });
  await f.tick(); assert.deepEqual(f.merged, ['head2']);
});

test('with session review off a completed session goes straight to done; request changes reruns it with feedback', async (t) => {
  const f = fixture(t, { ...input, reviewSessions: false });
  await f.approve(plan([sessionSpec('spike')]));
  f.report({ kind: 'completed', checks: ['Done'] }); await f.tick();
  assert.equal(f.sub().stage, 'done'); assert.equal(f.store.get(f.job.id).stage, 'done');

  const g = fixture(t);
  await g.approve(plan([sessionSpec('spike')]));
  g.report({ kind: 'completed', checks: ['Done'] }); await g.tick();
  assert.throws(() => g.store.action(g.job.id, 'revise-session', { subJobId: 'spike' }), /Explain/);
  g.store.action(g.job.id, 'revise-session', { subJobId: 'spike', feedback: 'Also check staging' });
  assert.equal(g.sub().stage, 'session'); assert.equal(g.sub().result, null);
  await g.tick();
  assert.equal(g.last().run.phase, 'session'); assert.equal(g.last().sub.feedback, 'Also check staging');
  g.report({ kind: 'completed', checks: ['Staging checked'] }); await g.tick();
  assert.equal(g.sub().stage, 'review'); assert.equal(g.sub().feedback, null);
});

// --- MCP and control ---

test('MCP receipts and context are caller-bound, launch-allowlisted, and carry the job and run only', async (t) => {
  const f = fixture(t); await f.approve(); const w = f.last();
  const deps = { jobStore: f.store };
  assert.equal((await getJobContextTool.handler({ deps, caller: 'other' })).structuredContent.job, null);
  const ctx = (await getJobContextTool.handler({ deps, caller: w.sid })).structuredContent;
  assert.deepEqual(Object.keys(ctx).sort(), ['job', 'run']);
  assert.equal(ctx.run.id, w.run.id); assert.equal(ctx.job.plan.context, plan().context);
  const report = { kind: 'published', url: PR_URL };
  assert.equal((await jobReportTool.handler({ deps, caller: 'other' }, { runId: w.run.id, report })).isError, true);
  const amended = await jobReportTool.handler({ deps, caller: w.sid }, { runId: w.run.id, report: { kind: 'blocked', summary: 's', amendment: { reason: 'r', ops: [] } } });
  assert.equal(amended.isError, true); assert.match(amended.content[0].text, /amendment/);
  assert.equal((await jobReportTool.handler({ deps, caller: w.sid }, { runId: w.run.id, report })).structuredContent.accepted, true);
  assert.equal(f.sub().stage, 'pr');
  const suggested = fixture(t);
  await suggested.approve();
  const s = suggested.last();
  await jobReportTool.handler({ deps: { jobStore: suggested.store }, caller: s.sid },
    { runId: s.run.id, report: { kind: 'blocked', summary: 'The proto is out of date', move: 'split-out' } });
  assert.equal(suggested.sub().blocked.move, 'split-out');
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

test('a move arrives as a job-action with its own fields and reaches the store whole', async (t) => {
  const f = fixture(t); await f.approve(); f.alive.clear(); await f.tick();
  const sent = [];
  const ctx = { jobStore: f.store, rebuild: async () => {}, runJobs: async () => {}, reply: (x) => sent.push(x) };
  await routeControlMessage(JSON.stringify({ type: 'job-action', id: f.job.id, subJobId: 'api', action: 'split-out',
    title: 'Sync the proto', brief: 'Regenerate the proto', position: 'after', note: 'small one' }), ctx);
  assert.equal(sent[0].type, 'job-action-complete');
  assert.deepEqual(f.store.get(f.job.id).subJobs.map((s) => s.id), ['api', 'api-2']);
});

// --- GitHub observation ---

const rawPr = { url: PR_URL, state: 'OPEN', headRefName: 'branch-api', headRefOid: 'head1', baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'tests', conclusion: 'SUCCESS' }] };
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
  assert.equal(f.sub().mergeRequestedHead, undefined);
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
  const sub = { repo: '/repo', pr: { mergeCommit: 'merged', base: 'main' } };
  const good = { databaseId: 1, headSha: 'merged', headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success', attempt: 1, workflowName: 'Deploy' };
  const calls = [];
  const gh = new JobGithub(async (_bin, args) => { calls.push(args); return JSON.stringify([good]); });
  assert.equal((await gh.deployment(sub)).status, 'passing');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--commit') && calls[0].includes('merged'));
  assert.ok(!calls[0].includes('--workflow') && !calls[0].includes('--branch'));

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

  gh.run = async () => JSON.stringify([{ ...good, conclusion: 'skipped' }]);
  const skipped = await gh.deployment(sub);
  assert.equal(skipped.status, 'pending'); assert.equal(skipped.runs[0].status, 'skipped');
  gh.run = async () => JSON.stringify([good, { ...good, databaseId: 2, workflowName: 'Scan', conclusion: 'skipped' }]);
  assert.equal((await gh.deployment(sub)).status, 'passing', 'a skipped sibling does not hold back a real deploy');

  gh.run = async () => JSON.stringify([{ ...good, databaseId: 9, conclusion: 'failure' }, { ...good, databaseId: 9, attempt: 2 }]);
  const rerun = await gh.deployment(sub);
  assert.equal(rerun.status, 'passing'); assert.equal(rerun.runs.length, 1);
});
