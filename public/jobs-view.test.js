import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { initJobsView } from './jobs-view.js';
import { jobCards, jobStatus, jobNeedsReview, dependencyLevels, jobCardHtml, jobBoardHeaderHtml, mergeHeldByComments } from './jobs.js';

const sub = (id, dependsOn = []) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', dependsOn, instructions: 'Implement and verify', deployment: { workflows: ['deploy.yml'], verify: 'Check version and behaviour' }, sessions: [], repairs: [] });
const plan = { stories: [{ id: 'story', key: 'AUTH-1', title: 'Customers can sign in', value: 'Access their account reliably' }], subJobs: [sub('api'), sub('web', ['api'])] };
function fixture(t) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prevDoc = globalThis.document, prevFormData = globalThis.FormData;
  globalThis.document = window.document; globalThis.FormData = window.FormData;
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const sent = [], sessions = [], diffs = [], onBoard = new Set();
  const view = initJobsView({ send: (m) => sent.push(structuredClone(m)), getAgents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'sonnet', label: 'Sonnet', default: true }] }], onSession: (s) => sessions.push(s), onDiff: (s) => diffs.push(s), onBoard: (s) => onBoard.has(s) });
  t.after(async () => { globalThis.document = prevDoc; globalThis.FormData = prevFormData; await window.happyDOM.close(); });
  const job = { id: 'job1', title: 'Sign-in', intent: 'Reliable sign-in', repos: ['/repo'], stage: 'planning', plan, subJobs: [], runs: [], revision: 2, reviewCode: true, reviewMerge: true };
  const data = { jobs: [structuredClone(job)], settings: { concurrency: 2, maxRepairs: 2, maxRunMinutes: 120 } };
  const q = (s) => document.querySelector(s);
  const event = (name) => new window.Event(name, { bubbles: true, cancelable: true });
  view.update(data);
  return { window, view, data, sent, q, event, sessions, diffs, onBoard };
}

test('every job gets its own six-column board and only boards with attention items survive Needs me', (t) => {
  const f = fixture(t);
  f.data.jobs.push({ ...f.data.jobs[0], id: 'backlog', stage: 'backlog', plan: null }); f.view.update(f.data);
  assert.equal(document.querySelectorAll('.job-board').length, 2); assert.equal(document.querySelectorAll('.job-column').length, 12);
  assert.deepEqual([...document.querySelectorAll('.job-board')].map((b) => b.dataset.board), ['job1', 'backlog']);
  assert.equal(document.querySelectorAll('.job-card').length, 2);
  f.q('#jobs-needs').checked = true; f.q('#jobs-needs').dispatchEvent(f.event('change'));
  assert.equal(document.querySelectorAll('.job-board').length, 1); assert.equal(document.querySelectorAll('.job-column').length, 6);
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
  assert.equal(f.q('[data-sub="cart"] .job-card-eyebrow').textContent, 'SHOP-7', 'the header names the job, so the card need not');
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

test('local review displays short receipts and pins approval to the visible receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', dependenciesVerified: true, local: { commitMessage: 'AUTH-1: sign-in', checks: ['Tests pass', 'Running curls pass'], receiptId: 'receipt1' }, worktree: { path: '/wt' }, sessions: ['s1'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.match(f.q('#job-dialog').textContent, /Commit message proposition/);
  assert.equal(document.querySelectorAll('.job-receipt li').length, 2);
  f.q('[data-action="approve-code"]').click(); assert.equal(f.sent.at(-1).localReceiptId, 'receipt1');
  f.q('#job-diff').click(); assert.deepEqual(f.diffs, ['s1']);
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
  assert.equal(dialog.querySelector('.job-comments p').textContent, 'Drops the <auth> check'); assert.equal(dialog.querySelector('.job-comments auth'), null);
  assert.match(dialog.textContent, /automatic merge is on hold/);
  f.q('[data-action="approve-merge"]').click(); assert.equal(f.sent.at(-1).action, 'approve-merge'); assert.equal(f.sent.at(-1).head, 'head1');
  job.subJobs[0].mergeApprovedHead = 'head1'; f.view.update(f.data);
  assert.equal(mergeHeldByComments(job, job.subJobs[0]), false); assert.equal(f.q('[data-action="approve-merge"]'), null);
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
