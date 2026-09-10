import { esc, tildify } from './util.js';
import { PULL_REQUEST_ICON, ROBOT_ICON } from './icons.js';
export const JOB_COLUMNS = [
  ['backlog', 'Backlog', 'Ideas ready to shape'],
  ['planning', 'Planning', 'Tickets, PRs and order'],
  ['jira', 'Jira tickets', 'Approved titles become tickets'],
  ['implementation', 'Work & PR', 'One session: work, commit, push, open the PR'],
  ['pr', 'PR', 'Checks, comments and merge'],
  ['deployment', 'Landing', 'Post-merge runs, then the check if there is one'],
  ['cleanup', 'Done', 'Worktree removed'],
];
// A job's second board: sub-jobs that are an agent session on this machine
// rather than a PR. Queued/Running are one stored stage ('session') split by
// whether a run is live; Review holds a receipt awaiting the human.
export const SESSION_COLUMNS = [
  ['queued', 'Queued', 'Waiting for prerequisites or an agent'],
  ['running', 'Running', 'An agent is on it'],
  ['review', 'Review', 'Read the receipt, then approve'],
  ['done', 'Done', 'Finished on this machine'],
];
export const isSessionSub = (sub) => sub?.kind === 'session';
export const hasSessionSubs = (job) => job.subJobs.some(isSessionSub);
// A sub-job is one of exactly two kinds, and the same chip names it everywhere one
// appears (board card, plan graph, detail heading) so the kinds are never told
// apart by wording alone: a PR (blue, pull-request glyph) or an agent session on
// this machine (purple, robot glyph, no PR).
export const kindLabel = (sub) => isSessionSub(sub) ? 'Session' : 'PR';
export const kindClass = (sub) => isSessionSub(sub) ? 'session' : 'pr';
export const kindChipHtml = (sub) => `<span class="job-kind ${kindClass(sub)}" title="${isSessionSub(sub) ? 'An agent session on this machine — no pull request' : 'A pull request in a repository'}">${isSessionSub(sub) ? ROBOT_ICON : PULL_REQUEST_ICON}${kindLabel(sub)}</span>`;
// "2 PRs · 1 session" rather than "3 sub-jobs": the count is where a reader first learns the mix.
export function kindCountLabel(subJobs) {
  const prs = subJobs.filter((s) => !isSessionSub(s)).length, sessions = subJobs.length - prs;
  return [prs ? `${prs} PR${prs === 1 ? '' : 's'}` : '', sessions ? `${sessions} session${sessions === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
}
export const cancelledDependencies = (job, sub) => sub.after.filter((id) => job.subJobs.find((s) => s.id === id)?.cancelledAt);
// Mirrors server/job-store.js dependencySatisfied: a PR counts once deployed, a session once done.
export const dependencySatisfied = (dep) => isSessionSub(dep) ? dep.stage === 'done' && !dep.cancelledAt : !!dep?.deployed;
export const pendingDependencies = (job, sub) => sub.after.map((id) => job.subJobs.find((s) => s.id === id)).filter((d) => !dependencySatisfied(d));
const liveRun = (job, sub) => job.runs.find((r) => !r.stopped && r.subJobId === (sub?.id || null));
// The live run's own card status, enriched onto the run server-side each graph
// tick (server/index.js withRunStatus). 'needs-you' is the one the board acts on:
// an automated step stuck on a prompt is nobody's but the human's.
export const runStatus = (job, sub) => liveRun(job, sub)?.status ?? null;
export const sessionColumn = (job, sub) => sub.stage === 'session' ? (liveRun(job, sub) ? 'running' : 'queued') : sub.stage === 'review' ? 'review' : 'done';
// undefined: no comments on the PR; null: comments read, verdict still being
// written (or stale after new comments); otherwise the summary for exactly the
// comment set on display. Mirrors server/job-comments.js commentsBlockMerge.
export function commentVerdict(sub) {
  if (!sub?.prComments?.items?.length) return undefined;
  return sub.commentSummary?.fingerprint === sub.prComments.fingerprint ? sub.commentSummary : null;
}
export const COMMENT_TONE_LABEL = { green: 'All good', amber: 'Needs attention', red: 'Blocks merging' };
export const redComments = (sub) => commentVerdict(sub)?.tone === 'red';
// Automatic merge stays on hold while comments read as blocking; approving the
// displayed head is the human override.
// A merged sub-job whose post-merge runs have shown nothing at all for longer than
// the stale window (server job-runner.js): nothing automatic will ever move it,
// so it is the human's to act on, unlike an ordinary slow deploy.
export const deploymentStalled = (sub) => sub?.stage === 'deployment' && !!sub.deploymentStale;
export const mergeHeldByComments = (job, sub) => sub?.stage === 'pr' && !job.reviewMerge && sub.pr?.checkStatus === 'passing' && redComments(sub) && sub.mergeApprovedHead !== sub.pr.head;
export const sessionReviewLabel = (job) => (job.reviewSessions ?? true) ? 'Session review on' : 'Sessions auto-complete';
export const reviewFlagsLabel = (job) => `${job.reviewMerge ? 'Manual merge' : 'Automatic merge'}${hasSessionSubs(job) ? ` · ${sessionReviewLabel(job)}` : ''}`;
// What the merge inference found for this PR's head (server job-deploys.js), in
// the words the human reads on the card and in the detail: "Deploys on merge · …"
// or "Merge completes it · …". Absent until the PR exists.
export const deploysLine = (sub) => sub?.deploys?.summary || '';

// The six moves a human makes by hand when something goes wrong. Agents never
// apply plan changes: a blocked receipt may only NAME one of these.
export const MOVES = [
  { id: 'fix-here', label: 'Fix here', blurb: 'New commit on this PR, with your note.' },
  { id: 'split-out', label: 'Split out', blurb: 'New PR, same ticket. Lands before or after this one.' },
  { id: 'new-ticket', label: 'New ticket', blurb: 'New story and PR for scope you didn’t know about.' },
  { id: 'reorder', label: 'Reorder', blurb: 'Change what this lands after.' },
  { id: 'drop', label: 'Drop', blurb: 'Cancel this sub-job.' },
  { id: 'mark', label: 'Mark position', blurb: 'Merged by hand. Deploy confirmed. Already covered elsewhere.' },
];
export const moveById = (id) => MOVES.find((m) => m.id === id) || null;
// Fix here on a sub-job with no PR yet is the same server move (note, then run it
// again) but promising "a new commit on this PR" would name something that does
// not exist, so the copy follows the sub-job's stage.
export function moveCopy(sub, move) {
  if (move.id !== 'fix-here' || (!isSessionSub(sub) && sub?.stage === 'pr')) return move;
  return { ...move, label: 'Retry with a note', blurb: isSessionSub(sub) ? 'Run this session again, with your note.' : 'Start the work again, with your note.' };
}
// Which "Mark position" claims this sub-job's stage can still accept — mirrors the
// server's gates so the form never offers a position the move would refuse.
export function markOptions(sub) {
  if (!sub || sub.cancelledAt || ['cleanup', 'done'].includes(sub.stage)) return [];
  const pr = !isSessionSub(sub);
  return [
    ...(pr && sub.stage === 'implementation' && !sub.pr ? [{ value: 'pr', label: 'A PR is already open for this work' }] : []),
    ...(pr && sub.stage === 'pr' ? [{ value: 'merged', label: 'Merged by hand' }] : []),
    { value: 'done', label: 'Done: deployed, or already covered elsewhere' },
  ];
}
// Mirrors server/job-moves.js: a move the server would refuse is never drawn.
// Nothing at all once the sub-job is finished, dropped, or already cleaning up.
export function movesFor(job, sub) {
  if (!sub || sub.cancelledAt || ['cleanup', 'done'].includes(sub.stage)) return [];
  const pr = !isSessionSub(sub);
  const allowed = {
    'fix-here': ['pr', 'implementation', 'session'].includes(sub.stage),
    'split-out': pr && ['implementation', 'pr', 'deployment'].includes(sub.stage),
    'new-ticket': true,
    reorder: ['implementation', 'pr', 'session'].includes(sub.stage),
    drop: true,
    mark: markOptions(sub).length > 0,
  };
  return MOVES.filter((m) => allowed[m.id]).map((m) => moveCopy(sub, m));
}
// The runner writes these error strings itself, so the short title is derived
// from them; anything it does not recognise keeps the neutral heading and lets
// the detail line — the agent's own sentence, or the observation — do the work.
const prNumber = (sub) => (sub?.pr?.url || '').split('/').filter(Boolean).pop();
function eventTitle(sub) {
  if (sub.blocked?.summary && sub.blocked.summary === sub.error) return 'Worker blocked';
  if (/closed without merging/i.test(sub.error)) return 'PR was closed';
  if (/repair limit/i.test(sub.error)) return prNumber(sub) ? `Checks failing on #${prNumber(sub)}` : 'Checks failing';
  if (/^Post-merge run failed/i.test(sub.error)) return 'Post-merge run failed';
  if (/without a receipt/i.test(sub.error)) return 'Session stopped early';
  return 'Needs attention';
}
// What happened, in one line, plus the move the agent suggested if it named one.
// `suggested` is only ever the agent's own `blocked.move` — the board never
// guesses a move on the human's behalf.
export function eventFor(job, sub) {
  if (!sub) return job.error ? { title: 'Job needs attention', detail: job.error, suggested: null } : null;
  if (sub.cancelledAt) return null;
  const suggested = sub.blocked?.move || null;
  if (sub.error) return { title: eventTitle(sub), detail: sub.error, suggested };
  if (deploymentStalled(sub)) return { title: 'Nothing deployed', detail: `No post-merge run has started for merge commit ${(sub.pr?.mergeCommit || '').slice(0, 8)}.`, suggested };
  if (sub.stage === 'pr' && redComments(sub)) return { title: 'Comments block merging', detail: commentVerdict(sub).text, suggested };
  return null;
}
export function jobNeedsReview(job, sub) {
  if (job.error || sub?.error) return true;
  // A step waiting on a prompt is the human's, whatever else the job is doing.
  if (runStatus(job, sub) === 'needs-you') return true;
  if (sub && mergeHeldByComments(job, sub)) return true;
  if (!sub) return job.stage === 'planning' && job.plan && !job.runs.some((r) => !r.stopped);
  if (!sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return true;
  if (isSessionSub(sub)) return sub.stage === 'review';
  if (deploymentStalled(sub)) return true;
  return sub.stage === 'pr' && sub.pr?.checkStatus === 'passing' && job.reviewMerge && sub.mergeApprovedHead !== sub.pr.head;
}
export function jobStatus(job, sub) {
  if (job.error || sub?.error) return { tone: 'needs', text: 'Needs attention' };
  if (sub?.cancelledAt) return { tone: sub.stage === 'done' ? 'done' : 'muted', text: sub.stage === 'done' ? 'Dropped' : 'Dropped · cleaning up' };
  if (job.paused) return { tone: 'muted', text: 'Paused' };
  if (sub && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return { tone: 'needs', text: 'Depends on a dropped sub-job' };
  const run = liveRun(job, sub);
  if (run) {
    if (run.status === 'needs-you') return { tone: 'needs', text: 'Waiting on a prompt' };
    return { tone: 'working', text: run.report ? 'Saving receipt' : ({ planning: 'Planning', jira: 'Creating Jira tickets', implementation: 'Working on the PR', repair: 'Fixing the PR', verify: 'Checking it landed', session: 'Working' }[run.phase] || 'Working') };
  }
  // A requested fix is a repair the runner picks up on its next tick, so it outranks
  // whatever the checks currently say.
  if (sub?.stage === 'pr' && sub.fixRequested) return { tone: 'working', text: 'Fix requested' };
  if (deploymentStalled(sub)) return { tone: 'needs', text: 'No deployment run' };
  if (jobNeedsReview(job, sub)) return { tone: 'needs', text: sub ? isSessionSub(sub) ? 'Ready to review' : sub.stage === 'pr' ? mergeHeldByComments(job, sub) ? 'Comments block merging' : 'Ready to merge' : 'Needs you' : 'Plan ready to review' };
  if (!sub) return { tone: 'muted', text: job.stage === 'backlog' ? 'Ready when you are' : job.stage === 'done' ? 'Delivered' : job.stage === 'jira' ? 'Tickets queued' : 'Queued' };
  // A session prerequisite blocks the work from starting; a PR prerequisite only blocks its merge.
  const waiting = pendingDependencies(job, sub);
  const blocked = sub.stage === 'session' ? waiting : sub.stage === 'implementation' ? waiting.filter(isSessionSub) : [];
  if (blocked.length) return { tone: 'muted', text: `Waiting for ${blocked.length} ${blocked.every(isSessionSub) ? 'session' : blocked.some(isSessionSub) ? 'prerequisite' : 'deployment'}${blocked.length === 1 ? '' : 's'}` };
  // A story added by New ticket has no key until the jira phase runs, and nothing starts without one.
  if (sub.stage === 'implementation' && !sub.jiraKey) return { tone: 'muted', text: 'Waiting for a Jira ticket' };
  if (sub.observationError) return { tone: 'needs', text: 'Pipeline polling will retry' };
  if (sub.stage === 'pr') return { tone: sub.pr?.checkStatus === 'passing' ? 'working' : 'muted', text: sub.mergeRequestedHead ? 'Merge requested' : sub.pr?.checkStatus === 'awaiting-review' ? 'GitHub review required' : 'Watching checks' };
  if (sub.stage === 'deployment') return sub.recoveredBy ? { tone: 'muted', text: 'Awaiting fix' } : { tone: 'muted', text: 'Watching post-merge runs' };
  if (sub.stage === 'done') return { tone: 'done', text: isSessionSub(sub) ? 'Completed' : 'Delivered' };
  return { tone: 'muted', text: 'Queued' };
}
export function jobCards(jobs) {
  return jobs.flatMap((job) => job.stage === 'active' || job.stage === 'done'
    ? [...job.subJobs.map((sub) => isSessionSub(sub) ? { job, sub, board: 'sessions', stage: sessionColumn(job, sub) } : { job, sub, board: 'prs', stage: sub.stage === 'done' ? 'cleanup' : sub.stage }), ...(job.error ? [{ job, sub: null, board: 'prs', stage: 'cleanup' }] : [])]
    : [{ job, sub: null, board: 'prs', stage: job.stage }]);
}
// "Deploy after" a PR, "after" a session (which must finish before this even starts).
export function dependencyLine(job, sub) {
  const deps = sub.after.map((id) => job.subJobs.find((s) => s.id === id) || { id, title: id });
  const names = (list) => list.map((d) => d.title).join(' + ');
  if (isSessionSub(sub)) return deps.length ? `After ${names(deps)}` : '';
  const sessions = deps.filter(isSessionSub), prs = deps.filter((d) => !isSessionSub(d));
  return [sessions.length ? `Start after ${names(sessions)}` : '', prs.length ? `Deploy after ${names(prs)}` : ''].filter(Boolean).join(' · ');
}
// What a job (or one sub-job) cost: planning, every step, CI repairs and the
// headless comment triage, summed server-side (server/job-spend.js) from every
// transcript its cards have owned. `~` for a Codex estimate, exactly as a session
// card reads it (cards.js). Empty for null/0 — a backlog job that has spent nothing
// shows no price rather than an authoritative-looking $0.00.
export const jobCostLabel = (usd, estimated) => typeof usd === 'number' && usd > 0 ? `${estimated ? '~' : ''}$${usd.toFixed(2)}` : '';
export const JOB_COST_TITLE = 'Total price of this job: planning, every implementation step, CI repairs and PR comment triage';
export const SUB_COST_TITLE = 'Price of this sub-job: every step it ran, its CI repairs and its comment triage';

// A story is an existing ticket (key) or a proposal awaiting the ticketing step.
export const storyLabel = (story) => story?.key || (story?.project ? `New in ${story.project}` : 'New story');
export const receiptHtml = (checks = []) => `<ul class="job-receipt">${checks.map((c) => `<li><span aria-hidden="true">✓</span> ${esc(c)}</li>`).join('')}</ul>`;
export function jobCardHtml({ job, sub }) {
  const status = jobStatus(job, sub);
  const deps = sub ? dependencyLine(job, sub) : '';
  const deploys = sub ? deploysLine(sub) : '';
  const cost = sub ? jobCostLabel(sub.usd, sub.usdEstimated) : '';
  return `<button class="job-card ${jobNeedsReview(job, sub) ? 'job-card-review' : ''} ${eventFor(job, sub) ? 'job-card-event' : ''} ${sub?.stage === 'done' ? 'job-card-done' : ''}" data-job="${esc(job.id)}" data-sub="${esc(sub?.id || '')}">
    <span class="job-card-eyebrow">${sub ? `${kindChipHtml(sub)}${sub.jiraKey ? `<span>${esc(sub.jiraKey)}</span>` : ''}` : 'JOB'}</span>
    <strong>${esc(sub?.title || job.title)}</strong>
    ${sub ? `<span class="job-card-meta">${isSessionSub(sub) ? 'Agent session on this machine' : esc(tildify(sub.repo).split('/').pop())}</span>` : `<span class="job-card-meta">${job.repos.length ? `${job.repos.length} repositor${job.repos.length === 1 ? 'y' : 'ies'}` : 'Repositories to discover'}</span>`}
    ${deps ? `<span class="job-card-deps">↳ ${esc(deps)}</span>` : ''}
    ${deploys ? `<span class="job-card-deploys">${esc(deploys)}</span>` : ''}
    ${sub?.note ? `<span class="job-card-note">Note: ${esc(sub.note)}</span>` : ''}
    ${commentsLineHtml(sub)}
    ${cost ? `<span class="job-card-cost" title="${esc(SUB_COST_TITLE)}">${esc(cost)}</span>` : ''}
    <span class="job-status ${status.tone}"><i></i>${esc(status.text)}</span>
  </button>`;
}
// The board header owns the job identity, so a sub-job card never has to carry
// its job's title itself.
export function jobBoardHeaderHtml(job) {
  // jobStatus's job-level 'Queued' describes a card waiting in a column; a live board reads as in progress.
  const status = job.stage === 'active' && jobStatus(job, null).text === 'Queued' ? { tone: 'working', text: 'In progress' } : jobStatus(job, null);
  const cost = jobCostLabel(job.usd, job.usdEstimated);
  const working = job.runs.filter((r) => !r.stopped).length;
  const needs = jobCards([job]).filter((c) => jobNeedsReview(c.job, c.sub)).length;
  const delivered = job.subJobs.filter((s) => s.stage === 'done' && !s.cancelledAt).length;
  const meta = [
    job.subJobs.length ? `${kindCountLabel(job.subJobs)}${delivered ? ` · ${delivered} delivered` : ''}` : job.repos.length ? `${job.repos.length} repositor${job.repos.length === 1 ? 'y' : 'ies'}` : 'Repositories to discover',
    working ? `${working} agent${working === 1 ? '' : 's'} working` : '',
    reviewFlagsLabel(job),
  ].filter(Boolean);
  return `<header class="job-board-header"><div class="job-board-title"><span class="jobs-kicker">JOB</span><button class="job-board-open" data-job="${esc(job.id)}" data-sub=""><h2>${esc(job.title)}</h2></button><span class="job-board-meta">${meta.map(esc).join(' · ')}</span></div>
    <div class="job-board-side">${cost ? `<span class="job-board-cost" title="${esc(JOB_COST_TITLE)}${job.usdEstimated ? ' · includes an estimate for Codex sessions' : ''}">${esc(cost)}</span>` : ''}<span class="job-status ${status.tone}"><i></i>${esc(status.text)}</span>${needs ? `<span class="job-board-needs">${needs} need${needs === 1 ? 's' : ''} you</span>` : ''}<button data-pause="${esc(job.id)}" ${job.paused ? 'data-paused="1"' : ''}>${job.paused ? 'Resume job' : 'Pause job'}</button></div></header>`;
}
export function commentsLineHtml(sub) {
  const n = sub?.prComments?.items?.length;
  if (!n) return '';
  const verdict = commentVerdict(sub);
  return `<span class="job-card-comments ${verdict ? esc(verdict.tone) : ''}">${n} PR comment${n === 1 ? '' : 's'} · ${verdict ? esc(COMMENT_TONE_LABEL[verdict.tone]) : 'summarising…'}</span>`;
}
export function dependencyLevels(plan) {
  const levels = new Map();
  function level(sub, visiting = new Set()) {
    if (levels.has(sub.id)) return levels.get(sub.id);
    if (visiting.has(sub.id)) return 0;
    visiting.add(sub.id);
    const n = sub.after.length ? 1 + Math.max(...sub.after.map((id) => {
      const parent = plan.subJobs.find((s) => s.id === id); return parent ? level(parent, new Set(visiting)) : 0;
    })) : 0;
    levels.set(sub.id, n); return n;
  }
  plan.subJobs.forEach((s) => level(s));
  return levels;
}
