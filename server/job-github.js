import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COMMENTS_QUERY, normaliseComments } from './job-comments.js';
const exec = promisify(execFile);
export async function runFile(bin, args, cwd) {
  const { stdout } = await exec(bin, args, { cwd: cwd?.startsWith('~/') ? path.join(os.homedir(), cwd.slice(2)) : cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}
const bad = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const good = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
export function prSummary(pr) {
  const checks = (pr.statusCheckRollup || []).map((c) => ({ name: c.name || c.context || 'Check',
    state: c.status && c.status !== 'COMPLETED' ? c.status : c.conclusion || c.state || 'PENDING' }));
  const failed = checks.some((c) => bad.has(c.state));
  const allGreen = checks.length > 0 && checks.every((c) => good.has(c.state));
  const mergeWithAdmin = pr.state === 'OPEN' && !pr.isDraft && allGreen
    && pr.reviewDecision === 'REVIEW_REQUIRED' && pr.mergeStateStatus === 'BLOCKED'
    && pr.mergeable === 'MERGEABLE';
  let checkStatus = 'pending';
  if (failed || pr.reviewDecision === 'CHANGES_REQUESTED' || pr.mergeStateStatus === 'DIRTY') checkStatus = 'failing';
  else if (mergeWithAdmin || (pr.mergeStateStatus === 'CLEAN' && !pr.isDraft && (allGreen || !checks.length))) checkStatus = 'passing';
  else if (allGreen && pr.reviewDecision === 'REVIEW_REQUIRED') checkStatus = 'awaiting-review';
  return { url: pr.url, state: pr.state, head: pr.headRefOid, branch: pr.headRefName,
    base: pr.baseRefName, mergeCommit: pr.mergeCommit?.oid || null,
    checkStatus, checks, mergeWithAdmin, dirty: pr.mergeStateStatus === 'DIRTY', reviewDecision: pr.reviewDecision };
}
export class JobGithub {
  constructor(run = runFile) { this.run = run; }
  async pr(sub) {
    const fields = 'url,state,isDraft,headRefOid,headRefName,baseRefName,mergeCommit,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup';
    const raw = JSON.parse(await this.run('gh', ['pr', 'view', sub.pr.url, '--json', fields], sub.repo));
    const repo = JSON.parse(await this.run('gh', ['repo', 'view', '--json', 'nameWithOwner'], sub.repo));
    const slug = new URL(raw.url).pathname.split('/').slice(1, 3).join('/');
    if (slug.toLowerCase() !== repo.nameWithOwner.toLowerCase() || raw.headRefName !== sub.worktree?.branch) {
      throw new Error('Reported PR does not belong to this repository and worktree branch');
    }
    const summary = prSummary(raw);
    if (summary.mergeWithAdmin) {
      const missing = await this.missingRequiredChecks(sub, summary, slug);
      if (missing.length) {
        summary.checks.push(...missing.map(name => ({ name, state: 'PENDING' })));
        summary.checkStatus = 'pending'; summary.mergeWithAdmin = false;
      }
    }
    return summary;
  }
  async comments(sub) {
    const raw = JSON.parse(await this.run('gh', ['api', 'graphql', '-f', `query=${COMMENTS_QUERY}`, '-f', `url=${sub.pr.url}`], sub.repo));
    return normaliseComments(raw?.data?.resource);
  }
  async missingRequiredChecks(sub, pr, slug) {
    const branch = encodeURIComponent(pr.base);
    const api = async (endpoint, ...flags) => JSON.parse(await this.run('gh', ['api', endpoint, ...flags], sub.repo));
    // A green rollup omits required checks which have never reported. Read both
    // classic branch protection and active repository/organization rulesets.
    const protection = (await api(`repos/${slug}/branches/${branch}`)).protection;
    if (!protection) throw new Error('Cannot determine required checks for the review override');
    const classic = protection.required_status_checks;
    const required = [
      ...(classic?.contexts || []).map(context => ({ context })),
      ...(classic?.checks || []).map(c => ({ context: c.context, appId: c.app_id })),
    ];
    const rules = (await api(`repos/${slug}/rules/branches/${branch}?per_page=100`, '--paginate', '--slurp')).flat();
    for (const rule of rules) {
      if (rule.type === 'required_status_checks') required.push(...rule.parameters.required_status_checks
        .map(c => ({ context: c.context, appId: c.integration_id })));
    }
    let runs = [];
    if (required.some(c => c.appId > 0)) {
      runs = (await api(`repos/${slug}/commits/${pr.head}/check-runs?per_page=100`, '--paginate', '--slurp')).flatMap(page => page.check_runs);
    }
    return [...new Set(required.filter(c => !pr.checks.some(check => check.name === c.context && good.has(check.state))
      || (c.appId > 0 && !runs.some(run => run.name === c.context && run.app?.id === c.appId
        && run.head_sha === pr.head && run.status === 'completed' && good.has(run.conclusion?.toUpperCase()))))
      .map(c => c.context))];
  }
  async merge(sub, { canMerge = () => true } = {}) {
    // Admin bypasses GitHub's CI enforcement too. Recheck before using it and
    // retain match-head so a push cannot silently replace the approved change.
    let admin = false;
    if (sub.pr.mergeWithAdmin) {
      const current = await this.pr(sub);
      if (current.state !== 'OPEN' || current.head !== sub.pr.head || current.checkStatus !== 'passing') {
        throw new Error('PR changed or checks are no longer green; waiting for a fresh observation');
      }
      admin = current.mergeWithAdmin;
    }
    if (!canMerge()) throw new Error('Job paused before merge');
    await this.run('gh', ['pr', 'merge', sub.pr.url, '--squash', ...(admin ? ['--admin'] : []), '--match-head-commit', sub.pr.head], sub.repo);
  }
  // Watch whatever GitHub actually started for this merge, rather than a list of
  // workflow names chosen before the merge existed: the plan cannot reliably
  // predict which workflows trigger on a push to the base branch, and a name that
  // never runs leaves a merged sub-job watching forever.
  //
  // Pinned to the merge COMMIT, not `--branch <base>` + "created after we merged":
  // a job's PR sub-jobs may merge into the same repository minutes apart, so a
  // sibling's deploy run would otherwise become this sub-job's evidence.
  // `pull_request` runs are the PR gate, already judged before the merge.
  //
  // No runs is PENDING, never passing — silence is indistinguishable from a run
  // that has not been queued yet (measured: 4-10s from merge to the first run),
  // so the runner flags a lasting silence for the human instead of inferring a
  // deployment nothing observed. A sub-job whose merge IS its delivery carries no
  // `deployment` at all and never reaches this poll.
  async deployment(sub) {
    if (!sub.pr.mergeCommit) throw new Error('Waiting for GitHub to report the merge commit');
    const runs = JSON.parse(await this.run('gh', ['run', 'list', '--commit', sub.pr.mergeCommit,
      '--limit', '100', '--json', 'databaseId,headSha,headBranch,event,status,conclusion,url,workflowName,attempt'], sub.repo))
      .filter((r) => r.headSha === sub.pr.mergeCommit && !['pull_request', 'pull_request_target'].includes(r.event));
    // One workflow can have several runs on one commit (a re-run, or a scan that
    // starts twice); the latest attempt is the live one, as for the named path.
    const latest = new Map();
    for (const r of runs.sort((a, b) => a.databaseId - b.databaseId || a.attempt - b.attempt)) latest.set(r.workflowName, r);
    // A skipped run is GitHub saying the workflow did not apply to this commit —
    // not a failure worth a recovery job, but not deployment evidence either, so
    // it neither blocks nor satisfies. All-skipped therefore reads as silence.
    const results = [...latest.values()].map((run) => ({ workflow: run.workflowName, runId: run.databaseId, url: run.url,
      status: run.status !== 'completed' ? 'pending' : run.conclusion === 'success' ? 'passing'
        : run.conclusion === 'skipped' ? 'skipped' : 'failing',
      conclusion: run.conclusion || null }));
    return { status: results.some((r) => r.status === 'failing') ? 'failing'
      : results.some((r) => r.status === 'passing') && !results.some((r) => r.status === 'pending') ? 'passing' : 'pending',
      runs: results, commit: sub.pr.mergeCommit };
  }
}
