import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';
import { jobInputSchema, settingsSchema, planSchema, reportSchema, amendmentSchema, isSessionSub, storiesKeyed } from './jobs-schema.js';
import { COMMENT_SETTLE_MS } from './job-comments.js';
import { validateAmendment, describeAmendment, authorityPermits } from './job-amendments.js';

const activeForSub = (job, sub) => job.runs.some((r) => !r.stopped && r.subJobId === sub.id);
const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const runnable = (run) => run && !run.stopped;
// A PR dependency is satisfied once deployed; a session dependency once its
// receipt was accepted through to done (a cancelled one never satisfies).
export const dependencySatisfied = (dep) => isSessionSub(dep) ? dep.stage === 'done' && !dep.cancelledAt : !!dep?.deployed;
export const dependenciesSatisfied = (job, sub) => sub.dependsOn.every((id) => dependencySatisfied(job.subJobs.find((s) => s.id === id)));
// Session prerequisites gate the START of a dependent; PR prerequisites only gate publishing.
export const sessionDependenciesDone = (job, sub) => sub.dependsOn.every((id) => { const d = job.subJobs.find((s) => s.id === id); return !isSessionSub(d) || dependencySatisfied(d); });
const reviewSessions = (job) => job.reviewSessions ?? true;
const planRepos = (plan) => [...new Set(plan.subJobs.filter((s) => !isSessionSub(s)).map((s) => s.repo))];
// The one place a plan entry becomes a live sub-job, so one approved with the plan
// and one added later by an amendment are indistinguishable to the runner.
export function buildSubJob(plan, s) {
  const jiraKey = s.jiraKey || plan.stories.find((t) => t.id === s.storyId).key;
  return { ...s, stage: isSessionSub(s) ? 'session' : 'implementation', state: 'queued', jiraKey,
    repairs: [], sessions: [], local: null, pr: null, prComments: null, commentSummary: null, deploymentResult: null, result: null };
}
function activate(j) {
  j.subJobs = j.plan.subJobs.map((s) => buildSubJob(j.plan, s));
  j.stage = 'active';
}
export const MERGE_IS_DELIVERY = 'Merged; nothing deploys from this repository';

// Only this store writes jobs. Mutations validate a copy and persist it BEFORE
// replacing memory, so failed validation/disk writes cannot half-approve a job.
export class JobStore {
  constructor(file = path.join(DATA_DIR, 'jobs.json')) {
    this.file = file;
    const raw = readJsonOrLoud(file, 'jobs.json');
    if (raw && (raw.version !== 1 || !Array.isArray(raw.jobs))) throw new Error('Unsupported jobs.json; refusing to discard jobs');
    this.data = raw || { version: 1, settings: settingsSchema.parse({}), jobs: [] };
  }
  snapshot() { return structuredClone(this.data); }
  get(id) { return structuredClone(this.data.jobs.find((j) => j.id === id)); }
  change(fn) {
    const next = this.snapshot();
    const result = fn(next);
    writeJsonAtomic(this.file, next);
    this.data = next;
    return structuredClone(result);
  }
  update(id, fn) {
    return this.change((data) => {
      const job = data.jobs.find((j) => j.id === id);
      if (!job) throw new Error('Job not found');
      fn(job); job.updatedAt = Date.now(); job.revision++;
      return job;
    });
  }
  settings(patch) {
    return this.change((d) => { d.settings = settingsSchema.parse({ ...d.settings, ...patch }); return d.settings; });
  }
  create(input, extra = {}) {
    const job = { ...jobInputSchema.parse(input), id: uid('job'), stage: 'backlog', revision: 0,
      createdAt: Date.now(), updatedAt: Date.now(), paused: false, plan: null, subJobs: [], runs: [], ...extra };
    return this.change((d) => { d.jobs.push(job); return job; });
  }
  // Approval authorises two things in order: the Jira changes (only if a story
  // still needs a ticket; a fully-keyed plan has nothing to write) and then the
  // implementation. Sub-jobs are only built once every story has its key, since a
  // sub-job's commit-message prefix and card eyebrow are that key.
  approvePlan(id, revision, editedPlan) {
    return this.update(id, (j) => {
      if (j.revision !== revision) throw new Error('The plan changed. Review the latest version before approving.');
      if (j.stage !== 'planning' || !j.plan || j.runs.some(runnable)) throw new Error('The plan is not ready for review');
      const plan = planSchema.parse(editedPlan || j.plan);
      j.plan = plan;
      j.repos = planRepos(plan);
      j.approvedAt = Date.now(); j.error = null;
      if (storiesKeyed(plan)) activate(j); else j.stage = 'jira';
    });
  }
  action(id, action, { subJobId, revision, feedback, plan, head, localReceiptId, sessionReceiptId, reason, ops, amendmentId } = {}) {
    if (action === 'approve-plan') return this.approvePlan(id, revision, plan);
    return this.update(id, (j) => {
      const s = subJobId ? j.subJobs.find((s) => s.id === subJobId) : null;
      if (subJobId && !s) throw new Error('Sub-job not found');
      // A human's plan change is proposed and applied in one step: the proposer is
      // the reviewer. It still goes through the same validation and record as an
      // agent's, so the history reads the same whoever asked.
      if (action === 'propose-amendment') {
        const a = this._propose(j, amendmentSchema.parse({ reason, ops }), 'human', s?.id || null);
        this._applyAmendment(j, a, 'accepted');
        return;
      }
      if (action === 'accept-amendment' || action === 'reject-amendment') {
        const a = (j.amendments || []).find((x) => x.id === amendmentId);
        if (!a || a.status !== 'proposed') throw new Error('No pending plan change with that id');
        a.decidedAt = Date.now();
        if (action === 'reject-amendment') { a.status = 'rejected'; a.feedback = String(feedback || '').trim().slice(0, 8000) || undefined; return; }
        // Re-judged against the job as it is NOW, not as it was proposed: a
        // proposal the job has moved past is recorded as invalid with the reason,
        // rather than thrown away or forced through.
        const check = validateAmendment(j, a.ops);
        if (!check.ok) { a.status = 'invalid'; a.error = check.error; return; }
        this._applyAmendment(j, a, 'accepted', check);
        return;
      }
      if (action === 'pause') { j.paused = true; return; }
      if (action === 'resume') { j.paused = false; return; }
      if (action === 'start') {
        if (j.stage !== 'backlog') throw new Error('Job has already started');
        j.stage = 'planning'; return;
      }
      if (action === 'replan') {
        if (j.stage !== 'planning' || j.runs.some(runnable)) throw new Error('Wait for planning to finish');
        j.feedback = String(feedback || '').trim().slice(0, 8000);
        if (!j.feedback) throw new Error('Explain the change you want');
        j.previousPlan = j.plan || j.previousPlan; j.plan = null; j.error = null; return;
      }
      if (action === 'retry') {
        const target = s || j;
        if (!target.error) throw new Error('Nothing is blocked');
        if (j.runs.some((r) => runnable(r) && r.subJobId === (s?.id || null))) throw new Error('The previous session is still stopping');
        target.error = null;
        if (s) { s.state = s.cancelledAt ? 'cancelled' : 'queued'; s.repairAllowance = (s.repairAllowance || 0) + 1; }
        return;
      }
      if (action === 'cancel') {
        if (!s) throw new Error('Choose a sub-job to cancel');
        if (s.stage === 'cleanup' || s.stage === 'done') throw new Error('Sub-job has already finished');
        // Straight to cleanup. The runner stops any live step; nothing merged, so
        // cleanup keeps every commit it cannot prove is retained elsewhere.
        s.cancelledAt = Date.now(); s.stage = 'cleanup'; s.state = 'cancelled';
        s.error = null; s.observationError = null; s.recoveryJobId = null; return;
      }
      if (action === 'revise-code') {
        if (!s || s.stage !== 'implementation' || activeForSub(j, s)) throw new Error('Wait for the local session to stop');
        s.feedback = String(feedback || '').trim().slice(0, 8000);
        if (!s.feedback) throw new Error('Explain the requested code change');
        s.local = null; s.error = null; s.codeApprovedAt = null; s.dependenciesVerified = false;
        return;
      }
      if (action === 'approve-code') {
        if (!s?.local || s.local.receiptId !== localReceiptId || !s.dependenciesVerified || s.stage !== 'implementation' || s.error) throw new Error('Local verification is not ready');
        s.codeApprovedAt = Date.now(); return;
      }
      if (action === 'revise-session') {
        if (!isSessionSub(s) || s.stage !== 'review' || activeForSub(j, s)) throw new Error('The session result is not ready for review');
        s.feedback = String(feedback || '').trim().slice(0, 8000);
        if (!s.feedback) throw new Error('Explain the requested change');
        s.result = null; s.error = null; s.stage = 'session'; s.state = 'queued';
        return;
      }
      if (action === 'approve-session') {
        if (!isSessionSub(s) || s.stage !== 'review' || !s.result || s.result.receiptId !== sessionReceiptId || s.error) throw new Error('The session result is not ready for review');
        s.sessionApprovedAt = Date.now(); s.stage = 'cleanup'; s.state = 'queued'; return;
      }
      if (action === 'approve-merge') {
        if (s?.stage !== 'pr' || s.pr?.checkStatus !== 'passing' || !head || head !== s.pr?.head || s.error) throw new Error('PR must have green checks first');
        // Approval belongs to these exact bytes. A later push invalidates it.
        s.mergeApprovedHead = s.pr.head; return;
      }
      throw new Error('Unknown job action');
    });
  }
  _propose(j, { reason, ops }, proposedBy, subJobId) {
    const check = validateAmendment(j, ops);
    if (!check.ok) throw new Error(check.error);
    const a = { id: uid('amd'), reason, proposedBy, subJobId, ops, classification: check.classification, summary: describeAmendment(j, ops), status: 'proposed', proposedAt: Date.now() };
    (j.amendments ||= []).push(a);
    return a;
  }
  // Applies an amendment that has already validated against THIS job state.
  // Refuses while a run is live on a targeted sub-job (mirrors revise-code): the
  // session is working to the plan it was launched with, and its receipt would
  // land on a plan it never saw. The reporting run of a receipt that carries the
  // amendment is exempt — it has reported, so it is finishing, not working.
  _applyAmendment(j, a, status, check = validateAmendment(j, a.ops), { ignoreRunId = null } = {}) {
    if (!check.ok) throw new Error(check.error);
    const targets = new Set([...check.targets, a.subJobId].filter(Boolean));
    if (j.runs.some((r) => runnable(r) && r.id !== ignoreRunId && targets.has(r.subJobId))) throw new Error('Wait for the session to stop before changing its plan');
    const now = Date.now();
    const both = (id, fn) => { fn(j.subJobs.find((x) => x.id === id)); const p = j.plan.subJobs.find((x) => x.id === id); if (p) fn(p); };
    for (const op of a.ops) {
      const s = j.subJobs.find((x) => x.id === op.subJobId);
      if (op.op === 'add-sub-job') { j.plan.subJobs.push(op.spec); j.subJobs.push(buildSubJob(j.plan, op.spec)); }
      else if (op.op === 'add-dependency') both(op.subJobId, (x) => { x.dependsOn = [...x.dependsOn, op.dependsOn]; });
      else if (op.op === 'remove-dependency') both(op.subJobId, (x) => { x.dependsOn = x.dependsOn.filter((d) => d !== op.dependsOn); });
      else if (op.op === 'set-deployment') {
        both(op.subJobId, (x) => { if (op.deployment) x.deployment = op.deployment; else delete x.deployment; });
        // A watching sub-job starts its watch over; dropping the deployment
        // while merged-but-not-deployed is exactly the
        // runner's no-deployment MERGED branch, taken late.
        if (s.stage === 'deployment') {
          s.deploymentResult = null; s.deploymentStale = null; s.nextPollAt = 0;
          if (!op.deployment) { s.deployed = { at: now, checks: [MERGE_IS_DELIVERY], commit: s.pr?.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; s.error = null; }
        }
      } else if (op.op === 'set-pending-checks') s.local.pendingChecks = op.pendingChecks;
      else if (op.op === 'set-instructions') {
        both(op.subJobId, (x) => { x.instructions = op.instructions; });
        s.local = null; s.codeApprovedAt = null; s.dependenciesVerified = false; s.feedback = a.reason;
      } else if (op.op === 'set-recovered-by') {
        // Parked: the runner marks it deployed once the fix sub-job is, in place of
        // a separate recovery job (job-runner.js).
        s.recoveredBy = op.fixSubJobId; s.recoveryReason = s.error || a.reason; s.error = null; s.state = 'awaiting-fix'; s.nextPollAt = 0;
      }
    }
    // Accepting IS the retry: a sub-job the proposing receipt left blocked has its
    // plan fixed now, so it re-queues the same way the Retry button would.
    for (const id of targets) {
      const s = j.subJobs.find((x) => x.id === id);
      if (!s?.error || s.cancelledAt) continue;
      s.error = null; s.state = ['pr', 'deployment'].includes(s.stage) ? 'watching' : 'queued'; s.nextPollAt = 0; s.repairAllowance = (s.repairAllowance || 0) + 1;
    }
    j.repos = planRepos(j.plan);
    a.status = status; a.decidedAt = now;
  }
  claim(jobId, subJobId, phase) {
    const job = this.data.jobs.find((j) => j.id === jobId);
    if (!job || job.paused || this.data.settings.paused
      || job.runs.some((r) => runnable(r) && r.subJobId === subJobId)
      || this.data.jobs.flatMap((j) => j.runs).filter(runnable).length >= this.data.settings.concurrency) return null;
    return this.change((d) => {
      const j = d.jobs.find((j) => j.id === jobId);
      const active = d.jobs.flatMap((j) => j.runs).filter(runnable);
      if (!j || j.paused || d.settings.paused || active.length >= d.settings.concurrency) return null;
      if (j.runs.some((r) => runnable(r) && r.subJobId === subJobId)) return null;
      const run = { id: uid('run'), subJobId, phase, startedAt: Date.now(), sessionId: null, stopped: false, report: null };
      j.runs.push(run); j.revision++;
      return run;
    });
  }
  bindRun(jobId, runId, sessionId, worktree) {
    return this.update(jobId, (j) => {
      const r = j.runs.find((r) => r.id === runId);
      if (!r || r.stopped) throw new Error('Run is no longer active');
      r.sessionId = sessionId;
      const s = j.subJobs.find((s) => s.id === r.subJobId);
      if (s && !s.sessions.includes(sessionId)) s.sessions.push(sessionId);
      if (worktree) { if (s) s.worktree = worktree; else j.planningWorktrees = [...(j.planningWorktrees || []), worktree]; }
    });
  }
  // The implementer renames its placeholder branch (name_branch) once it has read
  // the repository's convention; `sub.worktree` is a copy taken at launch, and
  // the PR observer (`job-github.js`) and cleanup both match on it, so the copy
  // must follow. Keyed on the reporting session, which is the only one allowed
  // to touch this sub-job's worktree; anything else (an autopilot run, a stale
  // session) is not a job's and is left alone.
  noteBranchRename(sessionId, branch) {
    const job = this.data.jobs.find((j) => j.runs.some((r) => !r.stopped && r.sessionId === sessionId));
    const run = job?.runs.find((r) => !r.stopped && r.sessionId === sessionId);
    const sub = run && job.subJobs.find((s) => s.id === run.subJobId);
    if (!sub?.worktree) return false;
    this.update(job.id, (j) => { const s = j.subJobs.find((x) => x.id === sub.id); s.worktree = { ...s.worktree, branch }; });
    return true;
  }
  report(caller, runId, input) {
    const report = reportSchema.parse(input);
    const job = this.data.jobs.find((j) => j.runs.some((r) => r.id === runId));
    if (!job) throw new Error('Unknown run');
    return this.update(job.id, (j) => {
      const r = j.runs.find((r) => r.id === runId);
      if (!caller || caller !== r.sessionId) throw new Error('Only the assigned session can report this run');
      // A lost HTTP reply can be retried safely, including after the worker stops.
      if (r.report) {
        if (JSON.stringify(r.report) === JSON.stringify(report)) return;
        throw new Error('This run already submitted a different report');
      }
      if (r.stopped) throw new Error('This run has stopped');
      const expected = { planning: 'plan', jira: 'jira', implementation: 'local', publish: 'published', repair: 'repaired', verify: 'deployed', session: 'completed' }[r.phase];
      if (report.kind !== expected && report.kind !== 'blocked') throw new Error(`This run must submit ${expected}`);
      const s = j.subJobs.find((s) => s.id === r.subJobId);
      r.report = report; r.reportedAt = Date.now();
      // A receipt racing a cancel is kept on the run for the record but never
      // moves the sub-job: a late `published` must not pull it back out of cleanup.
      if (!s?.cancelledAt) this._applyReceipt(j, r, s, report);
      // Judged against the state the receipt just produced, so a `published`
      // receipt can drop its own deployment and a `blocked` one can fix what
      // blocked it. An invalid amendment fails the whole report (update() discards
      // the copy) so the agent gets the error and can correct it, as with the
      // commit-message prefix.
      if (report.amendment) {
        const a = this._propose(j, report.amendment, { runId: r.id, sessionId: r.sessionId, phase: r.phase, subJobId: r.subJobId, receipt: report.kind }, r.subJobId);
        if (authorityPermits(j.amendmentAuthority ?? 'review', a.classification)) {
          // A live run on another targeted sub-job leaves it proposed for the human, never fails the receipt.
          try { this._applyAmendment(j, a, 'auto-accepted', undefined, { ignoreRunId: r.id }); } catch (e) { if (!/Wait for the session/.test(e.message)) throw e; }
        }
      }
    });
  }
  _applyReceipt(j, r, s, report) {
    if (report.kind === 'plan') {
      j.plan = report.plan;
      j.repos = planRepos(report.plan);
    }
    // The ticketing step fills in exactly the keys the approved plan lacked. An
    // approved key is part of what the human agreed to, so it cannot be swapped.
    if (report.kind === 'jira') {
      for (const { id, key } of report.stories) {
        const story = j.plan.stories.find((t) => t.id === id);
        if (!story) throw new Error(`Unknown story: ${id}`);
        if (story.key && story.key !== key) throw new Error(`${id} was approved as ${story.key}; keep that key`);
        story.key = key;
      }
      const missing = j.plan.stories.filter((t) => !t.key).map((t) => t.id);
      if (missing.length) throw new Error(`Every story needs a Jira key; still missing: ${missing.join(', ')}`);
      activate(j);
    }
    if (report.kind === 'local') { if (!report.commitMessage.startsWith(`${s.jiraKey}:`)) throw new Error('Commit message must start with the sub-job Jira key and colon'); s.dependenciesVerified = dependenciesSatisfied(j, s); s.local = { ...report, receiptId: r.id, at: Date.now() }; s.state = 'verified'; s.codeApprovedAt = null; }
    // A fresh head (new PR or repair push) is first observed after the comment
    // settle, so reviewers posting seconds after it lands are in that first read.
    if (report.kind === 'published') { s.pr = { url: report.url, checkStatus: 'pending' }; s.stage = 'pr'; s.state = 'watching'; s.nextPollAt = Date.now() + COMMENT_SETTLE_MS; }
    if (report.kind === 'repaired') { s.repairs.push({ ...report, at: Date.now() }); s.state = 'watching'; s.mergeApprovedHead = null; s.pr.checkStatus = 'pending'; s.nextPollAt = Date.now() + COMMENT_SETTLE_MS; }
    // A session's receipt is the whole deliverable; with review on it waits for a
    // human, otherwise cleanup (archive its session) takes it straight to done.
    if (report.kind === 'completed') { s.result = { ...report, receiptId: r.id, at: Date.now() }; s.feedback = null; s.stage = reviewSessions(j) ? 'review' : 'cleanup'; s.state = reviewSessions(j) ? 'verified' : 'queued'; }
    if (report.kind === 'deployed') { s.deployed = { checks: report.checks, at: Date.now(), commit: s.pr.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; }
    if (report.kind === 'blocked') { (s || j).error = report.summary; }
  }
}
