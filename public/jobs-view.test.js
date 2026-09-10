import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { initJobsView } from './jobs-view.js';
import { jobCards, jobStatus, jobNeedsReview, dependencyLevels, jobCardHtml, jobBoardHeaderHtml, mergeHeldByComments, movesFor, eventFor } from './jobs.js';

const sub = (id, after = []) => ({ id, title: `Deliver ${id}`, repo: '/repo', storyId: 'story', jiraKey: 'AUTH-1', after, brief: 'Implement it and open the PR', sessions: [], repairs: [] });
const plan = { context: 'Keys live in the vault; every service reads them at boot.', stories: [{ id: 'story', key: 'AUTH-1', title: 'Customers can sign in' }], subJobs: [sub('api'), sub('web', ['api'])] };
const deploys = (summary = 'Deploys on merge · Deploy') => ({ head: 'head1', base: 'main', expected: true, workflows: [{ name: 'Deploy', file: 'deploy.yml', triggers: true, reason: 'runs on push' }], summary });
function fixture(t) {
  const window = new Window({ url: 'http://localhost:7878' });
  const prevDoc = globalThis.document, prevFormData = globalThis.FormData;
  globalThis.document = window.document; globalThis.FormData = window.FormData;
  document.body.innerHTML = '<section id="jobs"></section><dialog id="job-dialog"></dialog>';
  const sent = [], sessions = [], diffs = [], diffContexts = [], onBoard = new Set();
  const view = initJobsView({ send: (m) => sent.push(structuredClone(m)), getAgents: () => [{ id: 'claude', label: 'Claude', models: [{ value: 'sonnet', label: 'Sonnet', default: true }] }], onSession: (s) => sessions.push(s), onDiff: (s, ctx) => { diffs.push(s); diffContexts.push(ctx); }, onBoard: (s) => onBoard.has(s) });
  t.after(async () => { globalThis.document = prevDoc; globalThis.FormData = prevFormData; await window.happyDOM.close(); });
  const job = { id: 'job1', title: 'Sign-in', intent: 'Reliable sign-in', repos: ['/repo'], stage: 'planning', plan, subJobs: [], runs: [], moves: [], revision: 2, reviewMerge: true };
  const data = { jobs: [structuredClone(job)], settings: { concurrency: 2, maxRepairs: 2 } };
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

test('the columns name the ladder every PR climbs: work, PR, landing, done', (t) => {
  const f = fixture(t);
  assert.deepEqual([...document.querySelectorAll('.job-column h2')].map((h) => h.textContent),
    ['Backlog', 'Planning', 'Jira tickets', 'Work & PR', 'PR', 'Landing', 'Done']);
  assert.match(f.q('.job-column[aria-label="Work & PR"] p').textContent, /One session: work, commit, push, open the PR/);
  assert.match(f.q('.job-column[aria-label="Landing"] p').textContent, /Post-merge runs/);
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

test('a card carries what the merge will do, the note left for the next session, and a red edge when something happened', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', deploys: deploys(), note: 'Rebase on <main> first', pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'pending', checks: [] } }];
  f.view.update(f.data);
  const card = f.q('[data-sub="api"]');
  assert.equal(card.querySelector('.job-card-deploys').textContent, 'Deploys on merge · Deploy');
  assert.equal(card.querySelector('.job-card-note').textContent, 'Note: Rebase on <main> first');
  assert.ok(!card.innerHTML.includes('<main>'), 'a note is human text on an agent surface: escaped');
  assert.equal(card.classList.contains('job-card-event'), false, 'nothing has gone wrong yet');
  job.subJobs[0].error = 'PR was closed without merging'; f.view.update(f.data);
  assert.equal(f.q('[data-sub="api"]').classList.contains('job-card-event'), true);
  assert.deepEqual(eventFor(job, job.subJobs[0]), { title: 'PR was closed', detail: 'PR was closed without merging', suggested: null });
});

test('a step waiting on a prompt is the human’s: it says so, and it counts under Needs me', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'implementation', stopped: false, status: 'working' }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Working on the PR' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), false);
  job.runs[0].status = 'needs-you'; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'needs', text: 'Waiting on a prompt' });
  assert.equal(jobNeedsReview(job, job.subJobs[0]), true); assert.equal(f.q('#jobs-review-count').textContent, '1');
  assert.match(f.q('[data-sub="api"] .job-status').textContent, /Waiting on a prompt/);
});

test('the event box names what happened and the move the agent suggested, and that move is the hot one', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation', error: 'The <proto> files are out of sync with the API',
    blocked: { summary: 'The <proto> files are out of sync with the API', move: 'split-out', phase: 'implementation', at: 1 } }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelector('.job-event b').textContent, 'Worker blocked');
  assert.equal(dialog.querySelector('.job-event p').textContent, 'The <proto> files are out of sync with the API');
  assert.ok(!dialog.innerHTML.includes('<proto>'), 'the agent’s sentence is escaped');
  assert.equal(dialog.querySelector('.job-event-move').textContent, 'Suggests Split out');
  assert.deepEqual([...dialog.querySelectorAll('.job-move')].map((b) => b.dataset.move), ['fix-here', 'split-out', 'new-ticket', 'reorder', 'drop', 'mark']);
  assert.deepEqual([...dialog.querySelectorAll('.job-move.hot')].map((b) => b.dataset.move), ['split-out'], 'suggested, not chosen');
  // Fix here on a sub-job with no PR promises a rerun, not a commit that cannot exist.
  assert.equal(dialog.querySelector('[data-move="fix-here"] b').textContent, 'Retry with a note');
  assert.ok(dialog.querySelector('[data-action="retry"]'), 'the plain retry is still there for a transient failure');
});

test('a finished, dropped or cleaning-up sub-job offers no moves at all', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'done' }), []);
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'cleanup' }), []);
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'pr', cancelledAt: 1 }), []);
  // Merged: the fix is a new PR, not a new commit here, and the order is settled.
  assert.deepEqual(movesFor(job, { ...sub('api'), stage: 'deployment' }).map((m) => m.id), ['split-out', 'new-ticket', 'drop', 'mark']);
  // A session has no repository to split a PR out of.
  assert.deepEqual(movesFor(job, { ...sub('api'), kind: 'session', stage: 'session' }).map((m) => m.id), ['fix-here', 'new-ticket', 'reorder', 'drop', 'mark']);
});

const openMove = (f, subId, move) => { f.q(`[data-sub="${subId}"]`).click(); f.q(`.job-move[data-move="${move}"]`).click(); return f.q('#job-move-form'); };

test('Fix here hands the next session a note and nothing else', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'fix-here');
  form.elements.note.value = '  Pin the client to v3  ';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'fix-here', note: 'Pin the client to v3' });
});

test('Split out asks for a whole PR and where it lands; a merged sub-job is not asked where', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'failing', checks: [] } },
    { ...sub('merged'), stage: 'deployment', pr: { url: 'https://github.com/org/repo/pull/2', mergeCommit: 'abc', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'split-out');
  form.elements.title.value = 'Sync the proto files';
  form.elements.brief.value = 'Regenerate the protos and land them on their own';
  form.elements.check.value = 'proto lint passes';
  form.querySelector('[name="position"][value="before"]').checked = true;
  form.elements.note.value = 'Land this first';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'split-out', title: 'Sync the proto files', brief: 'Regenerate the protos and land them on their own', position: 'before', check: 'proto lint passes', note: 'Land this first' });
  f.q('#job-move-back').click(); f.q('#job-dialog').close();
  const merged = openMove(f, 'merged', 'split-out');
  assert.equal(merged.querySelector('[name="position"]'), null, 'merged: the new PR simply lands next');
  assert.match(f.q('#job-dialog').textContent, /everything already waiting on this one waits for it instead/);
  merged.elements.title.value = 'Guard empty payloads'; merged.elements.brief.value = 'Reject an empty body with a 400';
  merged.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'merged', action: 'split-out', title: 'Guard empty payloads', brief: 'Reject an empty body with a 400', position: 'after' });
});

test('New ticket carries the story as well as the PR, and leaves out what was not filled in', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }]; f.view.update(f.data);
  const form = openMove(f, 'api', 'new-ticket');
  form.elements.storyTitle.value = 'Sign-ins are audited';
  form.elements.project.value = 'SEC';
  form.elements.title.value = 'Emit an audit event';
  form.elements.brief.value = 'Write one audit row per sign-in';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'new-ticket', storyTitle: 'Sign-ins are audited', title: 'Emit an audit event', brief: 'Write one audit row per sign-in', project: 'SEC' },
    'an untouched key, check, position or note is left out rather than sent empty');
  f.q('#job-move-back').click();
  const again = f.q('.job-move[data-move="new-ticket"]'); again.click();
  const second = f.q('#job-move-form');
  second.elements.storyTitle.value = 'Existing work'; second.elements.key.value = 'AUTH-9';
  second.elements.title.value = 'Reuse the audit writer'; second.elements.brief.value = 'Call the shared writer';
  second.querySelector('[name="position"][value="after"]').checked = true;
  second.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).key, 'AUTH-9'); assert.equal(f.sent.at(-1).position, 'after');
});

test('Reorder sends the whole new prerequisite list, from the same checkboxes the plan graph uses', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }, { ...sub('web'), stage: 'implementation' }, { ...sub('gone'), stage: 'cleanup', cancelledAt: 1 }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'reorder');
  assert.deepEqual([...form.querySelectorAll('[data-dep]')].map((c) => c.value), ['web'], 'a dropped sub-job is not a prerequisite anyone can pick');
  form.querySelector('[data-dep][value="web"]').checked = true;
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'reorder', after: ['web'] });
});

test('Drop is the old cancel: confirmed first, and it sends nothing but the move', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', checkStatus: 'pending' } }, { ...sub('web', ['api']), stage: 'implementation' }];
  job.runs = [{ id: 'r1', subJobId: 'api', phase: 'repair', stopped: false }];
  f.view.update(f.data);
  openMove(f, 'api', 'drop');
  assert.equal(f.sent.length, 0, 'dropping needs a confirmation first');
  assert.match(f.q('#job-dialog').textContent, /running step is stopped/); assert.match(f.q('#job-dialog').textContent, /pull request stays open/);
  f.q('#job-move-back').click(); assert.ok(f.q('.job-move[data-move="drop"]'), 'backing out returns to the detail view');
  f.q('.job-move[data-move="drop"]').click(); f.q('[data-drop]').click();
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'drop' });
  job.subJobs[0] = { ...job.subJobs[0], stage: 'cleanup', cancelledAt: 1 }; job.runs = []; f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Dropped · cleaning up');
  assert.equal(jobNeedsReview(job, job.subJobs[1]), true); assert.match(jobStatus(job, job.subJobs[1]).text, /dropped sub-job/);
  f.q('[data-sub="api"]').click(); assert.equal(f.q('.job-moves'), null, 'a dropped sub-job has no moves left');
  job.subJobs[0].stage = 'done'; f.view.update(f.data);
  assert.equal(jobStatus(job, job.subJobs[0]).text, 'Dropped');
  assert.match(f.q('#jobs-active-count').textContent, /0 delivered/);
});

test('Mark position offers only the claims this stage can accept, and insists on the URL for an open PR', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'implementation' }, { ...sub('open'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'pending', checks: [] } }];
  f.view.update(f.data);
  const form = openMove(f, 'api', 'mark');
  assert.deepEqual([...form.querySelectorAll('[name="position"]')].map((r) => r.value), ['pr', 'done']);
  form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.length, 0); assert.match(f.q('#job-move-error').textContent, /Paste the pull request URL/);
  form.elements.url.value = 'https://github.com/org/repo/pull/12';
  form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'api', action: 'mark', position: 'pr', url: 'https://github.com/org/repo/pull/12' });
  f.q('#job-move-back').click(); f.q('#job-dialog').close();
  const opened = openMove(f, 'open', 'mark');
  assert.deepEqual([...opened.querySelectorAll('[name="position"]')].map((r) => r.value), ['merged', 'done']);
  assert.equal(opened.elements.url, undefined, 'the PR is already known');
  opened.querySelector('[name="position"][value="done"]').checked = true;
  opened.elements.note.value = 'Shipped in last week’s release';
  opened.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'open', action: 'mark', position: 'done', note: 'Shipped in last week’s release' });
});

test('the moves a job has taken fold into a collapsed history that stays open across ticks', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'pending', checks: [] } }];
  job.moves = [{ id: 'mv_1', at: 1757400000000, subJobId: 'api', move: 'fix-here', detail: 'Fix here on “Deliver api”' },
    { id: 'mv_2', at: 1757400600000, subJobId: 'api', move: 'split-out', detail: 'Split out “<proto> sync” to land before this' }];
  f.view.update(f.data); f.q('.job-board-open').click();
  const history = f.q('.job-moves-history');
  assert.equal(history.open, false); assert.match(history.querySelector('summary').textContent, /Moves\s*2/);
  assert.deepEqual([...history.querySelectorAll('.job-move-log span')].map((e) => e.textContent), ['Split out “<proto> sync” to land before this', 'Fix here on “Deliver api”'], 'newest first');
  assert.ok(!history.innerHTML.includes('<proto>'), 'a move line is agent-adjacent text: escaped');
  assert.equal(history.querySelectorAll('.job-move-log small').length, 2, 'each move says when it was made');
  history.open = true; history.dispatchEvent(f.event('toggle'));
  f.view.update(f.data);
  assert.equal(f.q('.job-moves-history').open, true, 'the disclosure survives the tick');
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

test('the plan under review shows the shared context, each brief and each check — and no business-value prose', (t) => {
  const f = fixture(t); const [job] = f.data.jobs;
  job.plan.subJobs[0].check = 'helm list shows auth-api in dev and prod';
  f.view.update(f.data); f.q('[data-job="job1"]').click();
  const dialog = f.q('#job-dialog');
  assert.equal(dialog.querySelector('.job-context').textContent, 'Keys live in the vault; every service reads them at boot.');
  assert.equal(dialog.querySelectorAll('.job-stories p').length, 0, 'a story is a title; its value is not the board’s business');
  assert.match(dialog.textContent, /Implement it and open the PR/);
  assert.match(dialog.textContent, /Check after it lands: helm list shows auth-api in dev and prod/);
  assert.doesNotMatch(dialog.textContent, /No deployment: merging the PR completes it/, 'the runner infers what a merge deploys');
  assert.doesNotMatch(f.q('.job-authority').textContent, /[Cc]ode review/);
  assert.match(f.q('.job-authority').textContent, /Approve starts work in dedicated worktrees/);
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

test('a job session archived when its step stopped is offered as a restore, not a dead open', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', sessions: ['s1', 's2'] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.equal(f.q('#job-session').textContent, 'Restore session');
  f.onBoard.add('s2'); f.view.update(f.data);
  assert.equal(f.q('#job-session').textContent, 'Open session');
  f.q('#job-session').click(); assert.deepEqual(f.sessions, ['s2'], 'the latest run, live or archived');
});

test('PR review shows green checks, what runs on merge, CI changes, and approves only the displayed head', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', deploys: deploys(), worktree: { path: '/wt/api' }, sessions: ['s1'],
    pr: { url: 'https://github.com/org/repo/pull/1', head: 'head1', checkStatus: 'passing', mergeWithAdmin: true, checks: [{ name: 'Tests', state: 'SUCCESS' }] }, repairs: [{ changes: ['Fixed timeout'], checks: ['Tests pass'] }] }];
  f.view.update(f.data); f.q('[data-sub="api"]').click();
  assert.equal(f.q('.job-deploys').textContent, 'Deploys on merge · Deploy');
  assert.match(f.q('#job-dialog').textContent, /Deploy\s*runs on push/, 'the inferred workflows say why');
  assert.match(f.q('#job-dialog').textContent, /Changes after failed checks/); assert.match(f.q('#job-dialog').textContent, /Fixed timeout/);
  assert.match(f.q('#job-dialog').textContent, /Merging will override GitHub’s required review/);
  f.q('[data-action="approve-merge"]').click(); assert.equal(f.sent.at(-1).head, 'head1');
  // Reviewing the code is still a round trip out to the board's diff panel.
  f.q('#job-diff').click(); assert.deepEqual(f.diffs, ['s1']); assert.deepEqual(f.diffContexts, [{ jobId: 'job1', subId: 'api' }]);
  assert.equal(f.q('#job-dialog').open, false);
  f.view.openDetail('job1', 'api');
  assert.equal(f.q('#job-dialog').open, true, 'the same detail re-opens on the return leg');
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api');
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
  assert.equal(dialog.querySelector('.job-event b').textContent, 'Comments block merging', 'blocked comments are an event like any other');
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

test('new-job form sends chosen model, repositories and review settings, and nothing about code review', (t) => {
  const f = fixture(t); f.q('#job-new').click(); const form = f.q('#job-create-form');
  assert.equal(form.elements.reviewCode, undefined, 'code review happens on the PR now');
  assert.equal(form.elements.amendmentAuthority, undefined, 'agents never change the plan, so there is no authority to grant');
  form.elements.title.value = 'New value'; form.elements.intent.value = 'Deliver something useful';
  form.elements.repos.value = '/repo\n/repo\n/second';
  form.dispatchEvent(f.event('submit'));
  const msg = f.sent[0]; assert.equal(msg.type, 'job-create'); assert.deepEqual(msg.job.repos, ['/repo', '/second']);
  assert.equal(msg.job.model, 'sonnet'); assert.equal(msg.job.reviewMerge, true); assert.equal(msg.job.reviewSessions, true);
  assert.deepEqual(Object.keys(msg.job).filter((k) => /reviewCode|amendment/.test(k)), []);
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

test('global concurrency, pause and repair limits are explicit controls, and no step is on a clock', (t) => {
  const f = fixture(t); f.q('#jobs-concurrency').value = '4'; f.q('#jobs-concurrency').dispatchEvent(f.event('change'));
  assert.deepEqual(f.sent[0], { type: 'job-settings', patch: { concurrency: 4 } });
  f.q('#jobs-pause').click(); assert.equal(f.sent[1].patch.paused, true);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  assert.equal(form.elements.maxRunMinutes, undefined, 'a step ends with a receipt or an idle session, not a timeout');
  form.elements.maxRepairs.value = '1'; form.dispatchEvent(f.event('submit'));
  assert.deepEqual(f.sent.at(-1).patch, { maxRepairs: 1, deploymentStaleMinutes: 30 });
});

test('dependency waves, session waits and escaped titles remain compact', () => {
  assert.deepEqual([...dependencyLevels(plan)], [['api', 0], ['web', 1]]);
  const spike = { ...sub('spike'), kind: 'session', stage: 'session' };
  const job = { title: '<script>bad()</script>', stage: 'active', subJobs: [spike, { ...sub('web', ['spike']), stage: 'implementation' }], runs: [], moves: [] };
  assert.match(jobStatus(job, job.subJobs[1]).text, /Waiting for 1 session/);
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

const sessionSub = (id, after = []) => ({ id, kind: 'session', title: `Run ${id}`, storyId: 'story', jiraKey: 'AUTH-1', after, brief: 'Do it here', sessions: ['s1'], repairs: [] });

test('a job with agent sessions gets a second four-column lane, and a reported session waits under Review pinned to its receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sessionSub('spike'), stage: 'review', result: { checks: ['Schema documented'], receiptId: 'receipt9' } }, { ...sub('api', ['spike']), stage: 'implementation' }, { ...sessionSub('backfill', ['api']), stage: 'session' }];
  job.runs = [{ id: 'r1', subJobId: 'backfill', phase: 'session', stopped: false, status: 'working' }];
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
  assert.deepEqual(f.sent.at(-1), { type: 'job-action', id: 'job1', subJobId: 'spike', action: 'approve-session', head: undefined, sessionReceiptId: 'receipt9' });
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
  job.plan = structuredClone(plan); job.plan.stories = [{ id: 'story', title: 'Customers can sign in' }, { id: 'audit', project: 'SEC', key: undefined, title: 'Sign-ins are audited' }, { id: 'old', key: 'AUTH-9', title: 'Existing work' }];
  job.plan.subJobs[1].storyId = 'audit'; job.plan.subJobs.forEach((s) => delete s.jiraKey); f.view.update(f.data);
  f.q('[data-job="job1"]').click();
  assert.deepEqual([...document.querySelectorAll('.job-story-key')].map((e) => e.textContent), ['New story', 'New in SEC', 'AUTH-9']);
  assert.equal(document.querySelectorAll('.job-story-key.job-story-new').length, 2);
  assert.deepEqual([...document.querySelectorAll('.job-plan-story')].map((e) => e.textContent), ['New story', 'New in SEC']);
  assert.match(f.q('.job-authority').textContent, /creates the 2 new Jira stories with these titles, then starts work/);
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
  assert.match(f.q('.job-authority').textContent, /^Approve starts work/);
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
  assert.deepEqual(f.sent[0].plan.subJobs.map((s) => [s.title, s.after]), [['Deliver the API last', ['web']], ['Deliver web', []]]);
});

test('a live job shows the same graph with each box carrying its kind and status, opening its sub-job on click', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sessionSub('spike'), stage: 'review' }, { ...sub('api', ['spike']), stage: 'implementation' }]; f.view.update(f.data);
  assert.match(f.q('.job-board-meta').textContent, /^1 PR · 1 session/, 'the board header counts the kinds rather than "sub-jobs"');
  assert.equal(f.q('[data-sub="spike"] .job-kind').textContent, 'Session'); assert.equal(f.q('[data-sub="api"] .job-kind').textContent, 'PR');
  f.q('.job-board-open').click();
  assert.match(f.q('#job-dialog').textContent, /Keys live in the vault/, 'the job detail leads with the shared context');
  const nodes = [...document.querySelectorAll('button.job-node')];
  assert.deepEqual(nodes.map((n) => [n.dataset.openSub, n.classList.contains('session'), n.querySelector('.job-status').textContent]), [['spike', true, 'Ready to review'], ['api', false, 'Waiting for 1 session']]);
  assert.deepEqual([...document.querySelectorAll('.job-graph-edges path[data-from]')].map((p) => `${p.dataset.from}→${p.dataset.to}`), ['spike→api']);
  assert.equal(f.q('[data-node="api"] .job-node-line').textContent, 'Start after Run spike');
  f.q('[data-open-sub="api"]').click();
  assert.equal(f.q('#job-dialog h2').textContent, 'Deliver api'); assert.equal(f.q('.job-detail-meta .job-kind').textContent, 'PR');
  assert.equal(f.q('.job-graph'), null, 'a sub-job detail is about one sub-job, not the graph');
});

test('a merge that deploys nothing says so on the card and in the detail', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('docs'), stage: 'done', deploys: { head: 'h', base: 'main', expected: false, workflows: [], summary: 'Merge completes it · deployment-pipeline ignores **.md' },
    deployed: { at: 1, checks: ['Merged; nothing runs on push for these paths'], commit: 'abc' } }];
  f.view.update(f.data); f.q('#jobs-done').checked = true; f.q('#jobs-done').dispatchEvent(f.event('change'));
  assert.match(f.q('[data-sub="docs"]').textContent, /Merge completes it · deployment-pipeline ignores \*\*\.md/);
  f.q('[data-sub="docs"]').click();
  assert.match(f.q('#job-dialog').textContent, /Merged; nothing runs on push for these paths/);
});

test('a merged sub-job with no post-merge run turns amber, joins Needs me and says which move ends it', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  const watching = { ...sub('api'), stage: 'deployment', mergedAt: Date.now() - 40 * 60000, deploys: deploys(), pr: { url: 'https://github.com/org/repo/pull/1', mergeCommit: 'abcdef1234567890', base: 'main', checkStatus: 'passing', checks: [] },
    deploymentResult: { status: 'pending', runs: [{ workflow: 'Deploy', runId: 3, status: 'pending' }], commit: 'abcdef1234567890' } };
  job.subJobs = [watching]; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, watching), { tone: 'muted', text: 'Watching post-merge runs' }); assert.equal(jobNeedsReview(job, watching), false);
  watching.deploymentStale = { since: watching.mergedAt }; f.view.update(f.data);
  assert.deepEqual(jobStatus(job, watching), { tone: 'needs', text: 'No deployment run' }); assert.equal(jobNeedsReview(job, watching), true);
  assert.match(f.q('[data-sub="api"] .job-status').textContent, /No deployment run/);
  f.q('[data-sub="api"]').click();
  const text = f.q('#job-dialog').textContent;
  assert.match(text, /No GitHub Actions run has started for merge commit abcdef12 in 40 min/);
  assert.match(text, /Mark position: done/, 'it says what the human can do about it');
  assert.equal(f.q('.job-event b').textContent, 'Nothing deployed');
  assert.equal(jobStatus(job, { ...watching, stage: 'cleanup', deploymentStale: watching.deploymentStale }).text, 'Queued', 'stale is only meaningful while watching');
});

test('the stale window is an explicit automation setting', (t) => {
  const f = fixture(t); f.data.settings.deploymentStaleMinutes = 45; f.view.update(f.data);
  f.q('#jobs-settings').click(); const form = f.q('#job-settings-form');
  assert.equal(form.elements.deploymentStaleMinutes.value, '45');
  form.elements.deploymentStaleMinutes.value = '90'; form.dispatchEvent(f.event('submit'));
  assert.equal(f.sent.at(-1).patch.deploymentStaleMinutes, 90);
});

test('a requested fix reads as work about to happen, and the note rides on the card until the next receipt', (t) => {
  const f = fixture(t); const job = f.data.jobs[0]; job.stage = 'active';
  job.subJobs = [{ ...sub('api'), stage: 'pr', fixRequested: { note: 'Pin the client to v3', at: 1 }, note: 'Pin the client to v3',
    pr: { url: 'https://github.com/org/repo/pull/1', head: 'h1', checkStatus: 'passing', checks: [] } }];
  f.view.update(f.data);
  assert.deepEqual(jobStatus(job, job.subJobs[0]), { tone: 'working', text: 'Fix requested' });
  f.q('[data-sub="api"]').click();
  assert.match(f.q('#job-dialog').textContent, /Fix requested: Pin the client to v3/);
  assert.match(f.q('#job-dialog').textContent, /Note for the next session: Pin the client to v3/);
});
