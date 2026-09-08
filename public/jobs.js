import { esc, tildify } from './util.js';
export const JOB_COLUMNS = [
  ['backlog', 'Backlog', 'Ideas ready to shape'],
  ['planning', 'PR planning & Jira tickets', 'Value, scope and landing order'],
  ['implementation', 'Local implementation & verification', 'Build together. Verify briefly.'],
  ['pr', 'PR', 'Checks, repairs and merge'],
  ['deployment', 'Deployment verification', 'The right version, working live'],
  ['cleanup', 'Cleanup', 'Leave the workspace tidy'],
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
export const cancelledDependencies = (job, sub) => sub.dependsOn.filter((id) => job.subJobs.find((s) => s.id === id)?.cancelledAt);
// Mirrors server/job-store.js dependencySatisfied: a PR counts once deployed, a session once done.
export const dependencySatisfied = (dep) => isSessionSub(dep) ? dep.stage === 'done' && !dep.cancelledAt : !!dep?.deployed;
export const pendingDependencies = (job, sub) => sub.dependsOn.map((id) => job.subJobs.find((s) => s.id === id)).filter((d) => !dependencySatisfied(d));
const liveRun = (job, sub) => job.runs.find((r) => !r.stopped && r.subJobId === (sub?.id || null));
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
export const mergeHeldByComments = (job, sub) => sub?.stage === 'pr' && !job.reviewMerge && sub.pr?.checkStatus === 'passing' && redComments(sub) && sub.mergeApprovedHead !== sub.pr.head;
export function jobNeedsReview(job, sub) {
  if (job.error || sub?.error) return true;
  if (sub && mergeHeldByComments(job, sub)) return true;
  if (!sub) return job.stage === 'planning' && job.plan && !job.runs.some((r) => !r.stopped);
  if (!sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return true;
  if (isSessionSub(sub)) return sub.stage === 'review';
  return (sub.stage === 'implementation' && sub.local && sub.dependenciesVerified && job.reviewCode && !sub.codeApprovedAt)
    || (sub.stage === 'pr' && sub.pr?.checkStatus === 'passing' && job.reviewMerge && sub.mergeApprovedHead !== sub.pr.head);
}
export function jobStatus(job, sub) {
  if (job.error || sub?.error) return { tone: 'needs', text: sub?.recoveryJobId ? 'Recovery needs approval' : 'Needs attention' };
  if (sub?.cancelledAt) return { tone: sub.stage === 'done' ? 'done' : 'muted', text: sub.stage === 'done' ? 'Cancelled' : 'Cancelled · cleaning up' };
  if (job.paused) return { tone: 'muted', text: 'Paused' };
  if (sub && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return { tone: 'needs', text: 'Depends on a cancelled sub-job' };
  const run = liveRun(job, sub);
  if (run) return { tone: 'working', text: run.report ? 'Saving receipt' : ({ planning: 'Planning', implementation: 'Implementing', publish: 'Opening PR', repair: 'Repairing CI', verify: 'Verifying live', session: 'Working' }[run.phase] || 'Working') };
  if (jobNeedsReview(job, sub)) return { tone: 'needs', text: sub ? isSessionSub(sub) ? 'Ready to review' : sub.stage === 'pr' ? mergeHeldByComments(job, sub) ? 'Comments block merging' : 'Ready to merge' : 'Ready for code review' : 'Plan ready to review' };
  if (!sub) return { tone: 'muted', text: job.stage === 'backlog' ? 'Ready when you are' : job.stage === 'done' ? 'Delivered' : 'Queued' };
  // A session prerequisite blocks a build from starting; a PR prerequisite only blocks publishing.
  const waiting = pendingDependencies(job, sub);
  const blocked = sub.stage === 'session' ? waiting : sub.stage === 'implementation' ? (sub.local ? waiting : waiting.filter(isSessionSub)) : [];
  if (blocked.length) return { tone: 'muted', text: `Waiting for ${blocked.length} ${blocked.every(isSessionSub) ? 'session' : blocked.some(isSessionSub) ? 'prerequisite' : 'deployment'}${blocked.length === 1 ? '' : 's'}` };
  if (sub.observationError) return { tone: 'needs', text: 'Pipeline polling will retry' };
  if (sub.stage === 'pr') return { tone: sub.pr?.checkStatus === 'passing' ? 'working' : 'muted', text: sub.mergeRequestedHead ? 'Merge requested' : sub.pr?.checkStatus === 'awaiting-review' ? 'GitHub review required' : 'Watching checks' };
  if (sub.stage === 'deployment') return { tone: 'muted', text: 'Watching deployment' };
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
  const deps = sub.dependsOn.map((id) => job.subJobs.find((s) => s.id === id) || { id, title: id });
  const names = (list) => list.map((d) => d.title).join(' + ');
  if (isSessionSub(sub)) return deps.length ? `After ${names(deps)}` : '';
  const sessions = deps.filter(isSessionSub), prs = deps.filter((d) => !isSessionSub(d));
  return [sessions.length ? `Start after ${names(sessions)}` : '', prs.length ? `Deploy after ${names(prs)}` : ''].filter(Boolean).join(' · ');
}
export const receiptHtml = (checks = []) => `<ul class="job-receipt">${checks.map((c) => `<li><span aria-hidden="true">✓</span> ${esc(c)}</li>`).join('')}</ul>`;
export function jobCardHtml({ job, sub }) {
  const status = jobStatus(job, sub);
  const deps = sub ? dependencyLine(job, sub) : '';
  return `<button class="job-card ${jobNeedsReview(job, sub) ? 'job-card-review' : ''} ${sub?.stage === 'done' ? 'job-card-done' : ''}" data-job="${esc(job.id)}" data-sub="${esc(sub?.id || '')}">
    <span class="job-card-eyebrow">${esc(sub ? sub.jiraKey || (isSessionSub(sub) ? 'SESSION' : 'SUB-JOB') : job.recoveryOf ? 'RECOVERY JOB · APPROVAL REQUIRED' : 'JOB')}</span>
    <strong>${esc(sub?.title || job.title)}</strong>
    ${sub ? `<span class="job-card-meta">${isSessionSub(sub) ? 'Agent session on this machine' : esc(tildify(sub.repo).split('/').pop())}</span>` : `<span class="job-card-meta">${job.repos.length ? `${job.repos.length} repositor${job.repos.length === 1 ? 'y' : 'ies'}` : 'Repositories to discover'}</span>`}
    ${deps ? `<span class="job-card-deps">↳ ${esc(deps)}</span>` : ''}
    ${sub?.local ? `<span class="job-card-receipt">✓ ${sub.local.checks.length} local checks${sub.repairs.length ? ` · ${sub.repairs.length} CI repair${sub.repairs.length === 1 ? '' : 's'}` : ''}</span>` : ''}
    ${sub?.result ? `<span class="job-card-receipt">✓ ${sub.result.checks.length} check${sub.result.checks.length === 1 ? '' : 's'} reported</span>` : ''}
    ${sub?.deployed ? `<span class="job-card-receipt">✓ ${sub.deployed.checks.length} deployment checks</span>` : ''}
    ${commentsLineHtml(sub)}
    <span class="job-status ${status.tone}"><i></i>${esc(status.text)}</span>
  </button>`;
}
export const sessionReviewLabel = (job) => (job.reviewSessions ?? true) ? 'Session review on' : 'Sessions auto-complete';
// The board header owns the job identity, so a sub-job card never has to carry
// its job's title itself.
export function jobBoardHeaderHtml(job) {
  // jobStatus's job-level 'Queued' describes a card waiting in a column; a live board reads as in progress.
  const status = job.stage === 'active' && jobStatus(job, null).text === 'Queued' ? { tone: 'working', text: 'In progress' } : jobStatus(job, null);
  const working = job.runs.filter((r) => !r.stopped).length;
  const needs = jobCards([job]).filter((c) => jobNeedsReview(c.job, c.sub)).length;
  const delivered = job.subJobs.filter((s) => s.stage === 'done' && !s.cancelledAt).length;
  const meta = [
    job.subJobs.length ? `${job.subJobs.length} sub-job${job.subJobs.length === 1 ? '' : 's'}${delivered ? ` · ${delivered} delivered` : ''}` : job.repos.length ? `${job.repos.length} repositor${job.repos.length === 1 ? 'y' : 'ies'}` : 'Repositories to discover',
    working ? `${working} agent${working === 1 ? '' : 's'} working` : '',
    `${job.reviewCode ? 'Code review on' : 'Code review off'} · ${job.reviewMerge ? 'Manual merge' : 'Automatic merge'}${hasSessionSubs(job) ? ` · ${sessionReviewLabel(job)}` : ''}`,
  ].filter(Boolean);
  return `<header class="job-board-header"><div class="job-board-title"><span class="jobs-kicker">${esc(job.recoveryOf ? 'RECOVERY JOB · APPROVAL REQUIRED' : 'JOB')}</span><button class="job-board-open" data-job="${esc(job.id)}" data-sub=""><h2>${esc(job.title)}</h2></button><span class="job-board-meta">${meta.map(esc).join(' · ')}</span></div>
    <div class="job-board-side"><span class="job-status ${status.tone}"><i></i>${esc(status.text)}</span>${needs ? `<span class="job-board-needs">${needs} need${needs === 1 ? 's' : ''} you</span>` : ''}<button data-pause="${esc(job.id)}" ${job.paused ? 'data-paused="1"' : ''}>${job.paused ? 'Resume job' : 'Pause job'}</button></div></header>`;
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
    const n = sub.dependsOn.length ? 1 + Math.max(...sub.dependsOn.map((id) => {
      const parent = plan.subJobs.find((s) => s.id === id); return parent ? level(parent, new Set(visiting)) : 0;
    })) : 0;
    levels.set(sub.id, n); return n;
  }
  plan.subJobs.forEach((s) => level(s));
  return levels;
}
