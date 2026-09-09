import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { initJobsView } from './jobs-view.js';
import { jobCards, jobStatus, jobNeedsReview, dependencyLevels, jobCardHtml, jobBoardHeaderHtml, mergeHeldByComments } from './jobs.js';

const sub = (id, dependsOn = []) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', dependsOn, instructions: 'Implement and verify', deployment: { verify: 'Check version and behaviour' }, sessions: [], repairs: [] });
const plan = { stories: [{ id: 'story', key: 'AUTH-1', title: 'Customers can sign in', value: 'Access their account reliably' }], subJobs: [sub('api'), sub('web', ['api'])] };
function fixture(t) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prevDoc = globalThis.document, prevFormData = globalThis.FormData;
  globalThis.document = window.document; globalThis.FormData = window.FormData;
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const sent = [], sessions = [], diffs = [], diffContexts = [], onBoard = new Set();
  const view = initJobsView({ send: (m) => sent.push(structuredClone(m)), getAgents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'sonnet', label: 'Sonnet', default: true }] }], onSession: (s) => sessions.push(s), onDiff: (s, ctx) => { diffs.push(s); diffContexts.push(ctx); }, onBoard: (s) => onBoard.has(s) });
  t.after(async () => { globalThis.document = prevDoc; globalThis.FormData = prevFormData; await window.happyDOM.close(); });
  const job = { id: 'job1', title: 'Sign-in', intent: 'Reliable sign-in', repos: ['/repo'], stage: 'planning', plan, subJobs: [], runs: [], revision: 2, reviewCode: true, reviewMerge: true };
  const data = { jobs: [structuredClone(job)], settings: { concurrency: 2, maxRepairs: 2, maxRunMinutes: 120 } };
  const q = (s) => document.querySelector(s);
  const event = (name) => new window.Event(name, { bubbles: true, cancelable: true });
  view.update(data);
  return { window, view, data, sent, q, event, sessions, diffs, diffContexts, onBoard };
}

test('every job gets its own seven-column board and only boards with attention items survive Needs me', (t) => {
  const f = fixture(t);
  f.data.jobs.push({ ...f.data.jobs[0], id: 'backlog', stage: 'backlog', plan: null }); f.view.update(f.data);
  assert.equal(document.querySelectorAll('.job-board').length, 2); assert.equal(document.querySelectorAll('.job-column').length, 14);
  assert.deepEqual([...document.querySelectorAll('.job-board')].map((b) => b.dataset.board), ['job1', 'backlog']);
  assert.equal(document.querySelectorAll('.job-card').length, 2);
  f.q('#jobs-needs').checked = true; f.q('#jobs-needs').dispatchEvent(f.event('change'));
  assert.equal(document.querySelectorAll('.job-board').length, 1); assert.equal(document.querySelectorAll('.job-column').length, 7);
  assert.equal(document.querySelectorAll('.job-card').length, 1); assert.equal(f.q('.job-card').dataset.job, 'job1');
});

test('sub-jobs of different jobs never share a column, and a delivered job only returns with Show delivered', (t) => {
  const f = fixture(t); const [a] = f.data.jobs; a.stage = 'active';
  a.subJobs = [{ ...sub('api'), stage: 'pr' }];
  const b = { ...structuredClone(a), id: 'job2', title: 'Checkout', subJobs: [{ ...sub('cart'), stage: 'pr', jiraKey: 'SHOP-7' }] };
  const done = { ...structuredClone(a), id: 'job3', title: 'Old work', stage: 'done', subJobs: [{ ...sub('legacy'), stage: 'done' }] };
  f.data.jobs.push(b, done); f.view.update(f.data);
  const boards = [...document.querySelectorAll('.job-board')];
  assert.deepEqual(boards.map((x) => x.dataset.board), ['job1', 'job2'], 'the delivered job is hidden by default');
  assert.deepEqual(boards.map((x) => [...x.querySelectorAll('.job-card')].map((c) => c.dataset.sub)), [['api'], ['cart']]);
  assert.deepEqual(boards.map((x) => x.querySelector('.job-column[aria-label="PR"] .job-column-count').textContent), ['1', '1']);
  assert.match(boards[1].querySelector('.job-board-header').textContent, /Checkout/);
  assert.equal(f.q('[data-sub="cart"] .job-card-eyebrow').textContent, 'PRSHOP-7', 'the kind chip and the ticket; the header names the job, so the card need not');
  f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  assert.deepEqual([...document.querySelectorAll('.job-board')].map((x) => x.dataset.board), ['job1', 'job2', 'job3']);
  f.q('#jobs-filter').value = 'job2'; f.q('#jobs-filter').dispatchEvent(f.event('change'));
  assert.deepEqual([...document.querySelectorAll('.job-board')].map((x) => x.dataset.board), ['job2']);
  f.q('.job-board-open').click(); assert.match(f.q('#job-dialog').textContent, /Checkout/); assert.equal(f.q('#job-dialog h2').textContent, 'Checkout');
  f.q('#job-dialog').close();
  f.q('[data-pause="job2"]').click(); assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job2', action: 'pause' });
  b.paused = true; f.view.update(f.data);
  assert.equal(f.q('[data-pause="job2"]').textContent, 'Resume job'); f.q('[data-pause="job2"]').click(); assert.equal(f.sent.at(-1).action, 'resume');
});

test('planning edits survive live snapshots and submit the displayed revision', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  const title = f.q('[data-title="0"]'); title.value = 'Deliver secure API'; title.dispatchEvent(f.event('input'));
  f.data.jobs[0].revision = 3; f.view.update(f.data);
  assert.equal(f.q('[data-title="0"]').value, 'Deliver secure API');
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].revision, 2); assert.equal(f.sent[0].plan.subJobs[0].title, 'Deliver secure API');
  assert.equal(f.q('#job-dialog').open, true, 'remain open until server acknowledges');
  f.view.created(); assert.equal(f.q('#job-dialog').open, false);
});

test('the plan review has no branch field; a sub-job\'s detail shows the branch its worktree is actually on', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  assert.equal(f.q('[data-branch]'), null); assert.equal(f.q('.job-plan-branch'), null);
  f.q('#job-dialog').close();
  const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', worktree: { path: '/wt/api', branch: 'fix/AUTH-1-api', repoRoot: '/repo' } }, { ...sub('web', ['api']), stage: 'implementation' }]; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.equal(f.q('.job-plan-branch'), null, 'the graph stays uncluttered');
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('.job-detail-meta .job-plan-branch').textContent, 'fix/AUTH-1-api');
  f.q('#job-dialog').close(); f.q('[data-job="job1"]').click(); f.q('[data-open-sub="web"]').click();
  assert.equal(f.q('.job-detail-meta .job-plan-branch'), null, 'no worktree yet, nothing to show');
});

test('local review displays short receipts and pins approval to the visible receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', dependenciesVerified: true, local: { commitMessage: 'AUTH-1: sign-in', checks: ['Tests pass', 'Running curls pass'], receiptId: 'receipt1' }, worktree: { path: '/wt' }, sessions: ['s1'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.match(f.q('#job-dialog').textContent, /Commit message proposition/);
  assert.equal(document.querySelectorAll('.job-receipt li').length, 2);
  f.q('[data-action="approve-code"]').click(); assert.equal(f.sent.at(-1).localReceiptId, 'receipt1');
  f.q('#job-diff').click(); assert.deepEqual(f.diffs, ['s1']);
  // The reviewer has to be able to get back here, so the handover names where it came from.
  assert.deepEqual(f.diffContexts, [{ jobId: 'job1', subId: 'api' }]);
  assert.equal(f.q('#job-dialog').open, false);
  f.view.openDetail('job1', 'api');
  assert.equal(f.q('#job-dialog').open, true, 'the same detail re-opens on the return leg');
  assert.match(f.q('#job-dialog').textContent, /Commit message proposition/);
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api');
});

test('a job session archived when its step stopped is offered as a restore, not a dead open', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', sessions: ['s1', 's2'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.equal(f.q('#job-session').textContent, 'Restore session');
  f.onBoard.add('s2'); f.view.update(f.data);
  assert.equal(f.q('#job-session').textContent, 'Open session');
  f.q('#job-session').click(); assert.deepEqual(f.sessions, ['s2'], 'the latest run, live or archived');
});

test('PR-only verification is visible without a passed checkmark in local review', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', dependenciesVerified: true,
    local: { commitMessage: 'AUTH-1: Rename clients', checks: ['Tests pass'],
      pendingChecks: ['Dev/prod state-backed plans'], receiptId: 'receipt1' } }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.equal(document.querySelectorAll('.job-receipt li').length, 1);
  assert.doesNotMatch(f.q('.job-receipt').textContent, /state-backed/);
  assert.match(f.q('#job-dialog').textContent, /Still required in PR checks/);
  assert.match(f.q('.job-checks').textContent, /○ Dev\/prod state-backed plans/);
});

test('PR review shows green checks, CI changes, and approves only the displayed head', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', mergeWithAdmin: true, checks: [{ name: 'Tests', state: 'SUCCESS' }] }, repairs: [{ changes: ['Fixed timeout'], checks: ['Tests pass'] }] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.match(f.q('#job-dialog').textContent, /Changes after failed checks/); assert.match(f.q('#job-dialog').textContent, /Fixed timeout/);
  assert.match(f.q('#job-dialog').textContent, /Merging will override GitHub’s required review/);
  f.q('[data-action="approve-merge"]').click(); assert.equal(f.sent.at(-1).head, 'head1');
});

const prComments = (tone, fingerprint = 'f1') => ({
  prComments: { fetchedAt: 1, prAuthor: 'agent', truncated: 0, unresolved: 1, fingerprint, items: [
    { id: 'c1', kind: 'thread', author: 'bob', bot: false, body: 'Drops the <auth> check', at: '2026-09-08T10:00:00Z', url: 'https://github.com/org/repo/pull/1#c1', path: 'src/auth.js', line: 12, resolved: false, outdated: false },
    { id: 'r1', kind: 'review', state: 'APPROVED', author: 'ci-bot', bot: true, body: 'LGTM', at: '2026-09-08T10:01:00Z', url: 'https://github.com/org/repo/pull/1#r1' },
  ] },
  commentSummary: tone ? { tone, text: `${tone} summary text`, fingerprint: 'f1', at: 2, error: false } : null,
});

test('PR comments render escaped with their shaded verdict, and a red verdict holds automatic merge until approved', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.reviewMerge = false;
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] };
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr, ...prComments('red') }];
  f.view.update(f.data);
  assert.match(f.q('[data-sub="api"]').textContent, /2 PR comments · Blocks merging/); assert.ok(f.q('.job-card-comments.red'));
  assert.equal(mergeHeldByComments(job, job.subJobs[0]), true); assert.equal(jobNeedsReview(job, job.subJobs[0]), true);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Comments block merging');
  f.q('[data-sub="api"]').click();
  const dialog = f.q('#job-dialog');
  assert.ok(dialog.querySelector('.job-comment-summary.red')); assert.match(dialog.textContent, /Blocks merging.*red summary text/);
  assert.match(dialog.textContent, /1 unresolved thread/); assert.match(dialog.textContent, /src\/auth\.js:12/); assert.match(dialog.textContent, /ci-bot \(bot\) · review · approved/);
  dialog.querySelector('[data-comment-toggle="c1"]').click();
  assert.equal(dialog.querySelector('.job-comments p').textContent, 'Drops the <auth> check'); assert.equal(dialog.querySelector('.job-comments auth'), null);
  assert.match(dialog.textContent, /automatic merge is on hold/);
  f.q('[data-action="approve-merge"]').click(); assert.equal(f.sent.at(-1).action, 'approve-merge'); assert.equal(f.sent.at(-1).head, 'head1');
  job.subJobs[0].mergeApprovedHead = 'head1'; f.view.update(f.data);
  assert.equal(mergeHeldByComments(job, job.subJobs[0]), false); assert.equal(f.q('[data-action="approve-merge"]'), null);
});

test('a comment body stays hidden until shown, survives a live re-render, and hides again', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] };
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr, ...prComments('amber') }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  const dialog = f.q('#job-dialog');
  const bodies = () => [...dialog.querySelectorAll('.job-comments p')].map((p) => p.textContent);
  assert.deepEqual(bodies(), [], 'bodies are not rendered by default');
  assert.equal(dialog.querySelectorAll('[data-comment-toggle]').length, 2);
  assert.match(dialog.textContent, /bob · src\/auth\.js:12/, 'the meta line is still there');
  dialog.querySelector('[data-comment-toggle="c1"]').click();
  assert.deepEqual(bodies(), ['Drops the <auth> check']);
  assert.equal(dialog.querySelector('[data-comment-toggle="c1"]').textContent, 'Hide');
  f.view.update(f.data);
  assert.deepEqual(bodies(), ['Drops the <auth> check'], 'a graph tick must not snap it shut');
  dialog.querySelector('[data-comment-toggle="c1"]').click();
  assert.deepEqual(bodies(), []);
  assert.equal(dialog.querySelector('[data-comment-toggle="c1"]').textContent, 'Show comment');
});

test('green and amber verdicts, a pending summary and no comments each read distinctly without asking for review', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.reviewMerge = false;
  const pr = { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', checks: [] };
  for (const [state, expectCard, expectDetail] of [
    [prComments('green'), /All good/, /green summary text/], [prComments('amber'), /Needs attention/, /amber summary text/],
    [prComments(null), /summarising…/, /Summarising comments/], [prComments('green', 'f2'), /summarising…/, /Summarising comments/],
    [{ prComments: { items: [], fingerprint: 'e', unresolved: 0, truncated: 0 }, commentSummary: null }, /^(?!.*PR comment)/s, /No comments yet/],
  ]) {
    job.subJobs = [{ ...sub('api'), stage: 'pr', pr, ...state }]; f.view.update(f.data);
    assert.match(f.q('[data-sub="api"]').textContent, expectCard); assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
    f.q('[data-sub="api"]').click(); assert.match(f.q('#job-dialog').textContent, expectDetail);
    assert.equal(f.q('[data-action="approve-merge"]'), null, 'automatic merge needs no approval');
    f.q('#job-dialog').close();
  }
});

test('new-job form sends chosen model, repositories and review settings without starting work', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.title.value = 'New value'; form.elements.intent.value = 'Deliver something useful';
  form.elements.repos.value = '/repo\n/repo\n/second'; form.elements.reviewCode.checked = true;
  form.dispatchEvent(f.event('submit'));
  const msg = f.sent[0]; assert.equal(msg.type, 'job-create'); assert.deepEqual(msg.job.repos, ['/repo', '/second']);
  assert.equal(msg.job.model, 'sonnet'); assert.equal(msg.job.reviewMerge, true); assert.equal(msg.job.reviewCode, true);
  assert.equal(f.q('#job-dialog').open, true);
});

test('new jobs need only an outcome while repository hints stay optional', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.title.value = 'Reliable sign-in'; form.elements.intent.value = 'Customers can access their accounts';
  assert.equal(form.elements.repos.required, false);
  assert.equal(form.elements.repos.closest('details').open, false);
  assert.equal(form.checkValidity(), true);
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent[0].type, 'job-create'); assert.deepEqual(f.sent[0].job.repos, []);
  f.view.created();
  const job = f.data.jobs[0]; job.repos = []; job.plan = null; job.stage = 'backlog'; f.view.update(f.data);
  assert.match(f.q('.job-card').textContent, /Repositories to discover/);
  f.q('.job-card').click(); assert.match(f.q('#job-dialog').textContent, /discover the repositories/);
});

test('the plan review shows discovered checkout paths before approval', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan.subJobs[0].repo = '/projects/api/service'; job.plan.subJobs[1].repo = '/projects/web/service';
  job.repos = job.plan.subJobs.map((s) => s.repo); f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-plan-repo')].map((e) => e.textContent), job.repos);
  f.q('[data-action="approve-plan"]').click();
  assert.deepEqual(f.sent[0].plan.subJobs.map((s) => s.repo), job.repos);
});

test('global concurrency, pause and repair limits are explicit controls', (t) => {
  const f = fixture(t); f.q('#jobs-concurrency').value = '4'; f.q('#jobs-concurrency').dispatchEvent(f.event('change'));
  assert.deepEqual(f.sent[0], { type: 'job-settings', patch: { concurrency: 4 } });
  f.q('#jobs-pause').click(); assert.equal(f.sent[1].patch.paused, true);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form'); form.elements.maxRepairs.value = '1'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).patch.maxRepairs, 1);
});

test('dependency waves, deployed waits and escaped titles remain compact', () => {
  assert.deepEqual([...dependencyLevels(plan)], [['api', 0], ['web', 1]]);
  const job = { title: '<script>bad()</script>', stage: 'active', subJobs: [{ ...sub('api') }, { ...sub('web', ['api']), stage: 'implementation', local: { checks: ['Tests pass'] } }], runs: [] };
  assert.match(jobStatus(job, job.subJobs[1]).text, /Waiting for 1 deployment/);
  const html = jobCardHtml({ job, sub: job.subJobs[1] }) + jobBoardHeaderHtml({ ...job, runs: [], repos: [] }); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(jobNeedsReview(job, job.subJobs[1]), false);
});

test('cleanup failures stay discoverable even after every sub-job is delivered', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.error = 'Planning worktree has local changes'; job.subJobs = [{ ...sub('api'), stage: 'done' }];
  f.view.update(f.data); assert.equal(jobCards([job]).length, 2);
  assert.equal(document.querySelectorAll('.job-card').length, 1); f.q('[data-job="job1"]').click();
  assert.match(f.q('#job-dialog').textContent, /Planning worktree has local changes/); assert.ok(f.q('[data-action="retry"]'));
});

test('retry targets the job when a sub-job displays an inherited coordinator error', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.error = 'Could not observe a stopped worker';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  f.q('[data-action="retry"]').click();
  assert.equal(f.sent.at(-1).action, 'retry');
  assert.equal(f.sent.at(-1).id, job.id);
  assert.equal(f.sent.at(-1).subJobId, undefined);

  job.subJobs[0].error = 'Restore repository access';
  f.view.update(f.data);
  f.q('[data-action="retry"]').click();
  assert.equal(f.sent.at(-1).subJobId, 'api');
});

test('cancel is offered on unfinished sub-jobs, confirmed before sending, and flags dependents', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', checkStatus: 'pending' } }, { ...sub('web', ['api']), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'repair', stopped: false }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  f.q('#job-cancel').click();
  assert.equal(f.sent.length, 0, 'cancel needs a confirmation first');
  assert.match(f.q('#job-dialog').textContent, /running step is stopped/); assert.match(f.q('#job-dialog').textContent, /pull request stays open/);
  f.q('#job-cancel-back').click(); assert.ok(f.q('#job-cancel'), 'backing out returns to the detail view');
  f.q('#job-cancel').click(); f.q('[data-action="cancel"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'cancel' });

  job.subJobs[0] = { ...job.subJobs[0], stage: 'cleanup', cancelledAt: 1 }; job.runs = []; f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Cancelled · cleaning up');
  assert.equal(jobNeedsReview(job, job.subJobs[1]), true); assert.match(jobStatus(job, job.subJobs[1]).text, /cancelled sub-job/);
  f.q('[data-sub="api"]').click(); assert.equal(f.q('#job-cancel'), null, 'a cancelled sub-job cannot be cancelled again');
  job.subJobs[0].stage = 'done'; f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Cancelled');
  assert.match(f.q('#jobs-active-count').textContent, /0 delivered/);
});

const sessionSub = (id, dependsOn = []) => ({ id, kind: 'session', title: `Run ${id}`, storyId: 'story', jiraKey: 'AUTH-1', dependsOn, instructions: 'Do it here', sessions: ['s1'], repairs: [] });

test('a job with agent sessions gets a second four-column lane, and a reported session waits under Review pinned to its receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sessionSub('spike'), stage: 'review', result: { checks: ['Schema documented'], receiptId: 'receipt9' } }, { ...sub('api', ['spike']), stage: 'implementation' }, { ...sessionSub('backfill', ['api']), stage: 'session' }];
  job.runs = [{ id: 'r1', subJobId: 'backfill', phase: 'session', stopped: false }];
  f.view.update(f.data);
  assert.equal(document.querySelectorAll('.job-board-columns').length, 2);
  assert.deepEqual([...document.querySelectorAll('.job-board-lane')].map((e) => e.textContent), ['Pull requests', 'Agent sessions']);
  assert.equal(document.querySelectorAll('.job-board-sessions .job-column').length, 4);
  assert.equal(f.q('.job-board-sessions .job-column[aria-label="Review"] .job-card').dataset.sub, 'spike');
  assert.equal(f.q('.job-board-sessions .job-column[aria-label="Running"] .job-card').dataset.sub, 'backfill', 'a live run puts the card in Running');
  assert.equal(f.q('.job-board-columns:not(.job-board-sessions) [data-sub="api"] .job-card-deps').textContent, '↳ Start after Run spike');
  assert.equal(jobStatus(job, job.subJobs[1]).text, 'Waiting for 1 session'); assert.equal(jobStatus(job, job.subJobs[0]).text, 'Ready to review');
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  assert.match(f.q('.job-board-meta').textContent, /Session review on/);
  f.q('[data-sub="spike"]').click();
  assert.match(f.q('#job-dialog').textContent, /Schema documented/);
  f.q('[data-action="approve-session"]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'spike', action: 'approve-session', head: undefined, localReceiptId: undefined, sessionReceiptId: 'receipt9' });
  f.q('#job-revise-session').click();
  const form = f.q('#job-dialog form'); form.elements.feedback.value = 'Check staging too'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).action, 'revise-session'); assert.equal(f.sent.at(-1).feedback, 'Check staging too');
});

test('plans show session rows without a repository and new jobs default to reviewing session results', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  job.plan = { ...plan, subJobs: [sessionSub('spike'), sub('api', ['spike'])] }; f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.match(f.q('.job-plan-kind').textContent, /Agent session/); assert.equal(document.querySelectorAll('.job-plan-repo').length, 1);
  assert.deepEqual([...document.querySelectorAll('.job-node')].map((n) => [n.dataset.node, n.querySelector('.job-kind').textContent]), [['spike', 'Session'], ['api', 'PR']]);
  assert.match(f.q('.job-graph-legend').textContent, /runs as an agent session here, no PR/);
  assert.match(f.q('.job-authority').textContent, /approve each agent session/);
  f.q('#job-dialog').close();
  f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.title.value = 'Value'; form.elements.intent.value = 'Deliver it'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).job.reviewSessions, true);
});

test('a plan proposes story titles the human can edit, and approval of keyless stories says tickets follow', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan = structuredClone(plan); job.plan.stories = [{ id: 'story', title: 'Customers can sign in', value: 'Access their account reliably' }, { id: 'audit', project: 'SEC', key: undefined, title: 'Sign-ins are audited', value: 'Security can trace access' }, { id: 'old', key: 'AUTH-9', title: 'Existing work', value: 'Already ticketed' }];
  job.plan.subJobs[1].storyId = 'audit'; job.plan.subJobs.forEach((s) => delete s.jiraKey); f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-story-key')].map((e) => e.textContent), ['New story', 'New in SEC', 'AUTH-9']);
  assert.equal(document.querySelectorAll('.job-story-key.job-story-new').length, 2);
  assert.deepEqual([...document.querySelectorAll('.job-plan-story')].map((e) => e.textContent), ['New story', 'New in SEC']);
  assert.match(f.q('.job-authority').textContent, /creates the 2 new Jira stories with these titles, then starts local work/);
  const title = f.q('[data-story="0"]'); title.value = 'Customers sign in without lockouts'; title.dispatchEvent(f.event('input'));
  f.q('[data-action="approve-plan"]').click();
  assert.equal(f.sent[0].plan.stories[0].title, 'Customers sign in without lockouts');
  assert.equal(f.sent[0].plan.stories[0].key, undefined, 'the browser never mints a key');
  f.q('#job-dialog').close();
  // Approved: the job card waits in the Jira column while a ticketing session runs, and never asks for review.
  job.stage = 'jira'; job.plan = f.sent[0].plan; job.runs = [{ id: 'r2', subJobId: null, phase: 'jira', stopped: false }]; f.view.update(f.data);
  assert.equal(f.q('.job-column[aria-label="Jira tickets"] .job-column-count').textContent, '1');
  assert.equal(f.q('.job-column[aria-label="Jira tickets"] .job-status').textContent, 'Creating Jira tickets');
  assert.equal(jobNeedsReview(job, null), false);
  f.q('[data-job="job1"]').click();
  assert.match(f.q('#job-dialog').textContent, /Creating the approved Jira stories/);
  assert.equal(f.q('[data-action="approve-plan"]'), null);
});

test('a plan whose stories all exist reads as existing and approval starts work directly', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  assert.match(f.q('h3').textContent, /Existing Jira stories/);
  assert.match(f.q('.job-authority').textContent, /^Approve starts local work/);
  assert.equal(f.q('.job-story-key').textContent, 'AUTH-1');
});

test('a job board leads with its total price, and each sub-job card carries its own', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', usd: 3.5, usdEstimated: false }, { ...sub('web'), stage: 'implementation' }];
  job.usd = 12.345; job.usdEstimated = false; f.view.update(f.data);
  assert.equal(f.q('.job-board-cost').textContent, '$12.35');
  assert.equal(f.q('.job-board-side').firstElementChild.className, 'job-board-cost', 'the price leads the header side, not buried after the status');
  assert.match(f.q('.job-board-cost').title, /Total price of this job.*planning.*repairs.*comment triage/);
  assert.equal(f.q('[data-sub="api"] .job-card-cost').textContent, '$3.50');
  assert.equal(f.q('[data-sub="web"] .job-card-cost'), null, 'a sub-job with nothing attributed shows no price');
  // Codex is an estimate everywhere it is shown, exactly as a session card reads it.
  job.usd = 8; job.usdEstimated = true; job.subJobs[0].usdEstimated = true; f.view.update(f.data);
  assert.equal(f.q('.job-board-cost').textContent, '~$8.00');
  assert.equal(f.q('[data-sub="api"] .job-card-cost').textContent, '~$3.50');
  assert.match(f.q('.job-board-cost').title, /includes an estimate for Codex sessions/);
});

test('a job with no attributable spend shows no price rather than $0.00', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.usd = null; f.view.update(f.data);
  assert.equal(f.q('.job-board-cost'), null);
  job.usd = 0; f.view.update(f.data);
  assert.equal(f.q('.job-board-cost'), null, 'zero is "nothing attributed yet", not a price');
});

test('the detail dialog shows a sub-job price against the job total, and a job total alone', (t) => {
  const f = fixture(t); const [job] = f.data.jobs; job.stage = 'active';
  job.usd = 12.5; job.subJobs = [{ ...sub('api'), stage: 'pr', usd: 3.5 }]; f.view.update(f.data);
  f.q('[data-sub="api"]').click();
  assert.deepEqual([...document.querySelectorAll('#job-dialog .job-detail-cost')].map((e) => e.textContent), ['$3.50 this sub-job', '$12.50 job total']);
  f.q('#job-dialog').close();
  f.q('.job-board-open').click();
  assert.deepEqual([...document.querySelectorAll('#job-dialog .job-detail-cost')].map((e) => e.textContent), ['$12.50 job total']);
});

test('the plan is a dependency graph: a box per sub-job in its wave, an arrow per prerequisite, and a dependency edit moves the box', (t) => {
  const f = fixture(t); f.q('[data-job="job1"]').click();
  const waves = () => [...document.querySelectorAll('.job-graph-col')].map((c) => [...c.querySelectorAll('.job-node')].map((n) => n.dataset.node));
  const arrows = () => [...document.querySelectorAll('.job-graph-edges path[data-from]')].map((p) => `${p.dataset.from}→${p.dataset.to}`);
  assert.deepEqual(waves(), [['api'], ['web']]); assert.deepEqual(arrows(), ['api→web']);
  assert.equal(f.q('.job-plan-table'), null, 'the landing-order table is gone');
  assert.deepEqual([...document.querySelectorAll('.job-node-head .job-kind')].map((k) => k.textContent), ['PR', 'PR']);
  assert.equal(f.q('.job-graph-legend .job-kind'), null, 'a PR-only plan needs no kind legend');
  assert.match(f.q('[data-node="web"] .job-node-deps summary').textContent, /Deploy after Deliver api/);
  const details = f.q('[data-node="web"] .job-node-deps'); details.open = true; details.dispatchEvent(f.event('toggle'));
  const box = f.q('[data-node="web"] [data-dep]'); box.checked = false; box.dispatchEvent(f.event('change'));
  assert.deepEqual(waves(), [['api', 'web']]); assert.deepEqual(arrows(), [], 'independent work shares wave one with nothing pointing at it');
  assert.equal(f.q('[data-node="web"] .job-node-deps').open, true, 'the open editor survives the redraw');
  f.q('[data-node="api"] [data-dep]').checked = true; f.q('[data-node="api"] [data-dep]').dispatchEvent(f.event('change'));
  assert.deepEqual(waves(), [['web'], ['api']]); assert.deepEqual(arrows(), ['web→api']);
  const title = f.q('[data-node="api"] [data-title]'); title.value = 'Deliver the API last'; title.dispatchEvent(f.event('input'));
  f.q('[data-action="approve-plan"]').click();
  assert.deepEqual(f.sent[0].plan.subJobs.map((s) => [s.title, s.dependsOn]), [['Deliver the API last', ['web']], ['Deliver web', []]]);
});

test('a live job shows the same graph with each box carrying its kind and status, opening its sub-job on click', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sessionSub('spike'), stage: 'review' }, { ...sub('api', ['spike']), stage: 'implementation' }]; f.view.update(f.data);
  assert.match(f.q('.job-board-meta').textContent, /^1 PR · 1 session/, 'the board header counts the kinds rather than "sub-jobs"');
  assert.equal(f.q('[data-sub="spike"] .job-kind').textContent, 'Session'); assert.equal(f.q('[data-sub="api"] .job-kind').textContent, 'PR');
  f.q('.job-board-open').click();
  assert.match(f.q('#job-dialog h3').textContent, /Sub-jobs/); assert.match(f.q('#job-dialog h3 small').textContent, /1 PR · 1 session/);
  const nodes = [...document.querySelectorAll('button.job-node')];
  assert.deepEqual(nodes.map((n) => [n.dataset.openSub, n.classList.contains('session'), n.querySelector('.job-status').textContent]), [['spike', true, 'Ready to review'], ['api', false, 'Waiting for 1 session']]);
  assert.deepEqual([...document.querySelectorAll('.job-graph-edges path[data-from]')].map((p) => `${p.dataset.from}→${p.dataset.to}`), ['spike→api']);
  assert.equal(f.q('[data-node="api"] .job-node-line').textContent, 'Start after Run spike');
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api'); assert.equal(f.q('.job-detail-meta .job-kind').textContent, 'PR');
  assert.equal(f.q('.job-graph'), null, 'a sub-job detail is about one sub-job, not the graph');
});

test('a PR with no deployment reads as merge-completes-it on the plan, on its card once merged, and in its detail', (t) => {
  const f = fixture(t); const job = f.data.jobs[0];
  const { deployment, ...docs } = sub('docs');
  job.plan = { ...plan, subJobs: [docs] }; f.view.update(f.data); f.q('[data-job="job1"]').click();
  assert.match(f.q('#job-dialog').textContent, /No deployment: merging the PR completes it/);
  f.q('#job-dialog').close();
  job.stage = 'active'; job.subJobs = [{ ...docs, stage: 'done', deployed: { checks: ['Merged; nothing deploys from this repository'] } }];
  f.view.update(f.data); f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  assert.match(f.q('[data-sub="docs"]').textContent, /Merged · nothing to deploy/);
  f.q('[data-sub="docs"]').click(); assert.match(f.q('#job-dialog').textContent, /No deployment: merging the PR completes it/);
});

test('a merged sub-job with no deployment run turns amber, joins Needs me and explains itself; a slow deploy does not', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const watching = { ...sub('api'), stage: 'deployment', mergedAt: Date.now() - 40 * 60000, pr: { url: 'https://github.com/org/repo/pull/1', mergeCommit: 'abcdef1234567890', base: 'main', checkStatus: 'passing', checks: [] },
    deploymentResult: { status: 'pending', runs: [{ workflow: 'Deploy', runId: 3, status: 'pending' }], commit: 'abcdef1234567890' } };
  job.subJobs = [watching]; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, watching), { tone: 'muted', text: 'Watching deployment' }); assert.equal(jobNeedsReview(job, watching), false);
  watching.deploymentStale = { since: watching.mergedAt }; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, watching), { tone: 'needs', text: 'No deployment run' }); assert.equal(jobNeedsReview(job, watching), true);
  assert.match(f.q('[data-sub="api"] .job-status').textContent, /No deployment run/);
  f.q('[data-sub="api"]').click();
  const text = f.q('#job-dialog').textContent;
  assert.match(text, /No GitHub Actions run has started for merge commit abcdef12 in 40 min/);
  assert.match(text, /amend the sub-job to drop its deployment/, 'it says what the human can do about it');
  assert.equal(jobStatus(job, { ...watching, stage: 'cleanup', deploymentStale: watching.deploymentStale }).text, 'Queued', 'stale is only meaningful while watching');
});

test('the stale window is an explicit automation setting', (t) => {
  const f = fixture(t); f.data.settings.deploymentStaleMinutes = 45; f.view.update(f.data);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  assert.equal(form.elements.deploymentStaleMinutes.value, '45');
  form.elements.deploymentStaleMinutes.value = '90'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).patch.deploymentStaleMinutes, 90);
});

const amendment = (extra = {}) => ({ id: 'amd_1', reason: 'deploy.yml ignores <b>markdown</b>', subJobId: 'api', classification: 'weakening', status: 'proposed', proposedAt: 1757400000000,
  proposedBy: { runId: 'r1', sessionId: 's1', phase: 'publish', subJobId: 'api', receipt: 'blocked' }, ops: [{ op: 'set-deployment', subJobId: 'api', deployment: null }],
  summary: ['Drop deployment for Deliver api: merging <i>completes</i> it'], ...extra });

test('a pending plan change is a Needs me item on the job and the sub-jobs it touches, drawn as escaped diff lines with Accept and Reject', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active'; job.amendmentAuthority = 'auto-tighten';
  job.subJobs = [{ ...sub('api'), stage: 'pr', error: 'deploy.yml never runs for this change', pr: { url: 'https://github.com/org/repo/pull/1', checkStatus: 'failing', checks: [] } }, { ...sub('web', ['api']), stage: 'implementation' }];
  job.amendments = [amendment()]; f.view.update(f.data);
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(jobNeedsReview(job, null), true);
  assert.equal(jobNeedsReview(job, job.subJobs[1]), false, 'web is not touched');
  assert.equal(jobStatus({ ...job, subJobs: [{ ...job.subJobs[0], error: null }] }, { ...job.subJobs[0], error: null }).text, 'Plan change proposed');
  assert.match(f.q('.job-board-meta').textContent, /Tightening auto-applies/, 'the authority shows with the other review flags');
  assert.equal(f.q('#jobs-review-count').textContent, '1');
  f.q('.job-board-open').click();
  const dialog = f.q('#job-dialog');
  assert.match(dialog.textContent, /Proposed changes/);
  const box = dialog.querySelector('.job-amendment');
  assert.ok(box.classList.contains('amber')); assert.equal(box.querySelector('.job-amendment-class').textContent, 'Weakens');
  assert.match(box.querySelector('.job-amendment-by').textContent, /Proposed by the publish step on Deliver api/);
  assert.equal(box.querySelector('.job-amendment-reason').textContent, 'deploy.yml ignores <b>markdown</b>');
  assert.equal(box.querySelector('.job-amendment-diff li').textContent, 'Drop deployment for Deliver api: merging <i>completes</i> it');
  assert.equal(box.querySelector('b i'), null); assert.ok(!dialog.innerHTML.includes('<i>completes</i>'), 'agent text is escaped');
  assert.equal(dialog.querySelector('.job-amendment-history'), null, 'nothing decided yet');
  assert.match(dialog.querySelector('.job-detail-footer').textContent, /Tightening auto-applies/);
  box.querySelector('[data-accept-amendment]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'accept-amendment', amendmentId: 'amd_1' });
  box.querySelector('[data-reject-amendment]').click();
  assert.match(dialog.textContent, /Reject this plan change/);
  const form = dialog.querySelector('form'); form.elements.feedback.value = 'Keep the pipeline'; form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: undefined, action: 'reject-amendment', amendmentId: 'amd_1', feedback: 'Keep the pipeline' });
});

test('on the blocked sub-job the proposal sits above the actions and its primary button is the retry; a form in progress survives a graph tick', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', error: 'deploy.yml never runs for this change', pr: { url: 'https://github.com/org/repo/pull/1', checkStatus: 'failing', checks: [] } }];
  job.amendments = [amendment()]; f.view.update(f.data); f.q('[data-sub="api"]').click();
  const dialog = f.q('#job-dialog');
  assert.match(dialog.textContent, /Proposed plan change/);
  assert.equal(dialog.querySelector('[data-accept-amendment]').textContent, 'Accept and retry');
  assert.ok(dialog.querySelector('.job-amendment').compareDocumentPosition(dialog.querySelector('#job-session, #job-change-plan').closest('.job-actions')) & 4, 'the proposal precedes the actions');
  job.subJobs[0].error = null; f.view.update(f.data);
  assert.equal(dialog.querySelector('[data-accept-amendment]').textContent, 'Accept', 'nothing to retry once the block is cleared');
  dialog.querySelector('[data-reject-amendment]').click();
  dialog.querySelector('form').elements.feedback.value = 'half-typed';
  f.view.update(f.data);
  assert.equal(dialog.querySelector('form').elements.feedback.value, 'half-typed', 'a live tick does not replace an open form');
  dialog.querySelector('#job-amend-back').click(); assert.equal(dialog.querySelector('form'), null);
});

test('Change plan offers only what the stage still allows and sends exactly the changed fields as ops', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', local: { commitMessage: 'AUTH-1: x', checks: ['Tests pass'], pendingChecks: ['CI green', 'Plan clean'], receiptId: 'r' } }, { ...sub('web'), stage: 'implementation' }, { ...sub('old'), stage: 'done' }, { ...sub('watch'), stage: 'deployment', pr: { url: 'https://github.com/org/repo/pull/2', mergeCommit: 'abc', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  const dialog = f.q('#job-dialog');
  dialog.querySelector('#job-change-plan').click();
  const form = dialog.querySelector('#job-amend-form');
  assert.deepEqual([...form.querySelectorAll('[data-dep]')].map((c) => c.value), ['web', 'watch'], 'other unfinished sub-jobs, from the shared dependency editor');
  assert.ok(form.elements.verify); assert.ok(form.elements.pendingChecks); assert.ok(form.elements.instructions);
  form.elements.reason.value = 'Docs only';
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.length, 0); assert.match(dialog.querySelector('#job-amend-error').textContent, /Nothing changed/);
  form.querySelector('[data-dep][value="web"]').checked = true;
  form.querySelector('[name="deploymentMode"][value="none"]').checked = true;
  form.elements.pendingChecks.value = 'CI green\n\n';
  form.dispatchEvent(f.event('submit'));
  const msg = f.sent.at(-1);
  assert.equal(msg.action, 'propose-amendment'); assert.equal(msg.subJobId, 'api'); assert.equal(msg.reason, 'Docs only');
  assert.deepEqual(msg.ops, [{ op: 'add-dependency', subJobId: 'api', dependsOn: 'web' }, { op: 'set-deployment', subJobId: 'api', deployment: null }, { op: 'set-pending-checks', subJobId: 'api', pendingChecks: ['CI green'] }]);
  dialog.close();
  f.q('[data-sub="watch"]').click(); dialog.querySelector('#job-change-plan').click();
  const watching = dialog.querySelector('#job-amend-form');
  assert.equal(watching.querySelector('[data-dep]'), null, 'merged: dependencies are fixed'); assert.equal(watching.elements.instructions, undefined); assert.equal(watching.elements.pendingChecks, undefined);
  watching.elements.reason.value = 'Verify the docs site'; watching.elements.verify.value = 'Docs site shows it';
  watching.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1).ops, [{ op: 'set-deployment', subJobId: 'watch', deployment: { verify: 'Docs site shows it' } }]);
  watching.elements.verify.value = ''; watching.dispatchEvent(f.event('submit'));
  assert.match(dialog.querySelector('#job-amend-error').textContent, /how the deployed service will be verified/);
  dialog.close(); f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  f.q('[data-sub="old"]').click(); assert.equal(dialog.querySelector('#job-change-plan'), null, 'a finished sub-job has no plan left to change');
});

test('decided plan changes fold into a collapsed history that stays open across ticks, and a recovered sub-job says what it waits for', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'deployment', recoveredBy: 'fix', recoveryReason: 'Endpoint returned 500', pr: { url: 'https://github.com/org/repo/pull/1', mergeCommit: 'abc', checkStatus: 'passing', checks: [] } }, { ...sub('fix'), title: 'Guard empty payloads', stage: 'implementation' }];
  job.amendments = [amendment({ id: 'amd_a', status: 'accepted', decidedAt: 1757400060000, classification: 'neutral' }), amendment({ id: 'amd_b', status: 'rejected', feedback: 'No', proposedBy: 'human' }), amendment({ id: 'amd_c', status: 'invalid', error: 'already deployed' }), amendment({ id: 'amd_d', status: 'auto-accepted', classification: 'tightening' })];
  f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Awaiting fix'); assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
  f.q('.job-board-open').click();
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelectorAll('.job-amendments').length, 1, 'nothing pending: the only list is the history');
  const history = dialog.querySelector('.job-amendment-history');
  assert.equal(history.open, false); assert.match(history.querySelector('summary').textContent, /Plan changes\s*4/);
  assert.deepEqual([...history.querySelectorAll('.job-amendment b')].map((b) => b.textContent), ['Applied automatically', 'No longer applies', 'Rejected', 'Accepted'], 'newest first');
  assert.deepEqual([...history.querySelectorAll('.job-amendment')].map((b) => b.className.split(' ').at(-1)), ['green', 'red', '', 'green']);
  assert.match(history.textContent, /Feedback: No/); assert.match(history.textContent, /already deployed/); assert.match(history.textContent, /Proposed by you/); assert.match(history.textContent, /Tightens/);
  assert.equal(history.querySelector('[data-accept-amendment]'), null);
  history.open = true; history.dispatchEvent(f.event('toggle'));
  f.view.update(f.data);
  assert.equal(dialog.querySelector('.job-amendment-history').open, true, 'the disclosure survives the tick');
  dialog.querySelector('[data-open-sub="api"]').click();
  assert.match(dialog.textContent, /Deployment failed/); assert.match(dialog.textContent, /Guard empty payloads/); assert.match(dialog.textContent, /counts as deployed once it does/);
  assert.equal(dialog.querySelector('#job-recovery'), null, 'no separate recovery job to review');
  dialog.querySelector('[data-open-sub="fix"]').click(); assert.equal(dialog.querySelector('h2').textContent, 'Guard empty payloads');
});

test('the new-job form carries the plan-change authority, defaulting to review', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  form.elements.title.value = 'Value'; form.elements.intent.value = 'Deliver it';
  assert.deepEqual([...form.elements.amendmentAuthority.options].map((o) => o.value), ['review', 'auto-tighten', 'auto']);
  form.dispatchEvent(f.event('submit')); assert.equal(f.sent.at(-1).job.amendmentAuthority, 'review');
  form.elements.amendmentAuthority.value = 'auto'; form.dispatchEvent(f.event('submit')); assert.equal(f.sent.at(-1).job.amendmentAuthority, 'auto');
});
