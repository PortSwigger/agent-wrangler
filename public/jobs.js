import { esc, tildify } from './util.js';
export const JOB_COLUMNS = [
  ['backlog', 'Backlog', 'Ideas ready to shape'],
  ['planning', 'PR planning & Jira tickets', 'Value, scope and landing order'],
  ['implementation', 'Local implementation & verification', 'Build together. Verify briefly.'],
  ['pr', 'PR', 'Checks, repairs and merge'],
  ['deployment', 'Deployment verification', 'The right version, working live'],
  ['cleanup', 'Cleanup', 'Leave the workspace tidy'],
];
export const cancelledDependencies = (job, sub) => sub.dependsOn.filter((id) => job.subJobs.find((s) => s.id === id)?.cancelledAt);
export function jobNeedsReview(job, sub) {
  if (job.error || sub?.error) return true;
  if (!sub) return job.stage === 'planning' && job.plan && !job.runs.some((r) => !r.stopped);
  if (!sub.cancelledAt && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return true;
  return (sub.stage === 'implementation' && sub.local && sub.dependenciesVerified && job.reviewCode && !sub.codeApprovedAt)
    || (sub.stage === 'pr' && sub.pr?.checkStatus === 'passing' && job.reviewMerge && sub.mergeApprovedHead !== sub.pr.head);
}
export function jobStatus(job, sub) {
  if (job.error || sub?.error) return { tone: 'needs', text: sub?.recoveryJobId ? 'Recovery needs approval' : 'Needs attention' };
  if (sub?.cancelledAt) return { tone: sub.stage === 'done' ? 'done' : 'muted', text: sub.stage === 'done' ? 'Cancelled' : 'Cancelled · cleaning up' };
  if (job.paused) return { tone: 'muted', text: 'Paused' };
  if (sub && sub.stage !== 'done' && cancelledDependencies(job, sub).length) return { tone: 'needs', text: 'Depends on a cancelled sub-job' };
  const run = job.runs.find((r) => !r.stopped && r.subJobId === (sub?.id || null));
  if (run) return { tone: 'working', text: run.report ? 'Saving receipt' : ({ planning: 'Planning', implementation: 'Implementing', publish: 'Opening PR', repair: 'Repairing CI', verify: 'Verifying live' }[run.phase] || 'Working') };
  if (jobNeedsReview(job, sub)) return { tone: 'needs', text: sub ? sub.stage === 'pr' ? 'Ready to merge' : 'Ready for code review' : 'Plan ready to review' };
  if (!sub) return { tone: 'muted', text: job.stage === 'backlog' ? 'Ready when you are' : job.stage === 'done' ? 'Delivered' : 'Queued' };
  const waiting = sub.dependsOn.filter((id) => !job.subJobs.find((s) => s.id === id)?.deployed);
  if (sub.local && sub.stage === 'implementation' && waiting.length) return { tone: 'muted', text: `Waiting for ${waiting.length} deployment${waiting.length === 1 ? '' : 's'}` };
  if (sub.observationError) return { tone: 'needs', text: 'Pipeline polling will retry' };
  if (sub.stage === 'pr') return { tone: sub.pr?.checkStatus === 'passing' ? 'working' : 'muted', text: sub.mergeRequestedHead ? 'Merge requested' : sub.pr?.checkStatus === 'awaiting-review' ? 'GitHub review required' : 'Watching checks' };
  if (sub.stage === 'deployment') return { tone: 'muted', text: 'Watching deployment' };
  if (sub.stage === 'done') return { tone: 'done', text: 'Delivered' };
  return { tone: 'muted', text: 'Queued' };
}
export function jobCards(jobs) {
  return jobs.flatMap((job) => job.stage === 'active' || job.stage === 'done'
    ? [...job.subJobs.map((sub) => ({ job, sub, stage: sub.stage === 'done' ? 'cleanup' : sub.stage })), ...(job.error ? [{ job, sub: null, stage: 'cleanup' }] : [])]
    : [{ job, sub: null, stage: job.stage }]);
}
export const receiptHtml = (checks = []) => `<ul class="job-receipt">${checks.map((c) => `<li><span aria-hidden="true">✓</span> ${esc(c)}</li>`).join('')}</ul>`;
export function jobCardHtml({ job, sub }) {
  const status = jobStatus(job, sub);
  const deps = sub?.dependsOn.map((id) => job.subJobs.find((s) => s.id === id)?.title || id) || [];
  return `<button class="job-card ${jobNeedsReview(job, sub) ? 'job-card-review' : ''} ${sub?.stage === 'done' ? 'job-card-done' : ''}" data-job="${esc(job.id)}" data-sub="${esc(sub?.id || '')}">
    <span class="job-card-eyebrow">${esc(sub ? job.title : job.recoveryOf ? 'RECOVERY JOB · APPROVAL REQUIRED' : 'JOB')}</span>
    <strong>${esc(sub?.title || job.title)}</strong>
    ${sub ? `<span class="job-card-meta">${esc(sub.jiraKey)} · ${esc(tildify(sub.repo).split('/').pop())}</span>` : `<span class="job-card-meta">${job.repos.length ? `${job.repos.length} repositor${job.repos.length === 1 ? 'y' : 'ies'}` : 'Repositories to discover'}</span>`}
    ${deps.length ? `<span class="job-card-deps">↳ Deploy after ${esc(deps.join(' + '))}</span>` : ''}
    ${sub?.local ? `<span class="job-card-receipt">✓ ${sub.local.checks.length} local checks${sub.repairs.length ? ` · ${sub.repairs.length} CI repair${sub.repairs.length === 1 ? '' : 's'}` : ''}</span>` : ''}
    ${sub?.deployed ? `<span class="job-card-receipt">✓ ${sub.deployed.checks.length} deployment checks</span>` : ''}
    <span class="job-status ${status.tone}"><i></i>${esc(status.text)}</span>
  </button>`;
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
