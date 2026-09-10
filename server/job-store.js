import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';
import { readJsonOrLoud, writeJsonAtomic } from './atomic-json.js';
import { jobInputSchema, settingsSchema, planSchema, reportSchema, isSessionSub, storiesKeyed } from './jobs-schema.js';
import { COMMENT_SETTLE_MS } from './job-comments.js';
import { applyMove, MOVE_ACTIONS } from './job-moves.js';

const activeForSub = (job, sub) => job.runs.some((r) => !r.stopped && r.subJobId === sub.id);
const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const runnable = (run) => run && !run.stopped;
// A PR dependency is satisfied once deployed; a session dependency once its
// receipt was accepted through to done (a cancelled one never satisfies).
export const dependencySatisfied = (dep) => isSessionSub(dep) ? dep.stage === 'done' && !dep.cancelledAt : !!dep?.deployed;
export const dependenciesSatisfied = (job, sub) => sub.after.every((id) => dependencySatisfied(job.subJobs.find((s) => s.id === id)));
// Session prerequisites gate the START of a dependent; PR prerequisites only gate merging.
export const sessionDependenciesDone = (job, sub) => sub.after.every((id) => { const d = job.subJobs.find((s) => s.id === id); return !isSessionSub(d) || dependencySatisfied(d); });
const reviewSessions = (job) => job.reviewSessions ?? true;
const planRepos = (plan) => [...new Set(plan.subJobs.filter((s) => !isSessionSub(s)).map((s) => s.repo))];
// The one place a plan entry becomes a live sub-job, so one approved with the
// plan and one added later by a move are indistinguishable to the runner. A
// keyless story leaves `jiraKey` null: New ticket's Jira step fills it in, and
// the sub-job cannot start until it has one.
export function buildSubJob(plan, s) {
  const jiraKey = s.jiraKey || plan.stories.find((t) => t.id === s.storyId)?.key || null;
  return { ...s, stage: isSessionSub(s) ? 'session' : 'implementation', state: 'queued', jiraKey,
    repairs: [], sessions: [], pr: null, prComments: null, commentSummary: null, deploys: null,
    deploymentResult: null, result: null, note: null, fixRequested: null, blocked: null };
}
function activate(j) {
  j.subJobs = j.plan.subJobs.map((s) => buildSubJob(j.plan, s));
  j.stage = 'active';
}
export const MERGE_IS_DELIVERY = 'Merged; nothing runs on push for these paths';
export const CURRENT_VERSION = 2;

const drop = (obj, ...keys) => { for (const k of keys) delete obj[k]; };
// Version 1 named the plan's edges `dependsOn` and its text `instructions`, and
// carried the whole verification vocabulary the runner now infers (deployment,
// local receipts, code approval) plus amendments and recovery jobs. Migration is
// in memory and persisted by the next ordinary write, so a downgrade before then
// still finds its own file. Legacy text may exceed today's caps — it is NOT
// truncated, because the cap is a rule for what a planner may propose, not a
// reason to damage work already approved.
function migrateSub(s) {
  s.after = s.after || s.dependsOn || [];
  s.brief = s.brief || s.instructions || s.title;
  drop(s, 'dependsOn', 'instructions', 'deployment', 'local', 'dependenciesVerified', 'codeApprovedAt', 'recoveryJobId', 'recoveryReason');
  // It had a local receipt and was waiting to publish; one implementation
  // session now commits, pushes and opens the PR from that same worktree.
  if (s.stage === 'implementation' && s.state === 'verified') s.state = 'queued';
  return s;
}
function migratePlan(plan) {
  if (!plan) return plan;
  plan.context = plan.context ?? '';
  for (const story of plan.stories || []) drop(story, 'value');
  for (const s of plan.subJobs || []) migrateSub(s);
  return plan;
}
export function migrateJobs(raw) {
  if (!raw) return null;
  if (![1, CURRENT_VERSION].includes(raw.version) || !Array.isArray(raw.jobs)) throw new Error('Unsupported jobs.json; refusing to discard jobs');
  const data = structuredClone(raw);
  data.version = CURRENT_VERSION;
  if (data.settings) drop(data.settings, 'maxRunMinutes');
  for (const job of data.jobs) {
    drop(job, 'reviewCode', 'amendmentAuthority', 'amendments', 'recoveryOf');
    migratePlan(job.plan); migratePlan(job.previousPlan);
    for (const s of job.subJobs || []) migrateSub(s);
  }
  return data;
}

// Only this store writes jobs. Mutations validate a copy and persist it BEFORE
// replacing memory, so failed validation/disk writes cannot half-approve a job.
export class JobStore {
  constructor(file = path.join(DATA_DIR, 'jobs.json')) {
    this.file = file;
    this.data = migrateJobs(readJsonOrLoud(file, 'jobs.json'))
      || { version: CURRENT_VERSION, settings: settingsSchema.parse({}), jobs: [] };
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
      createdAt: Date.now(), updatedAt: Date.now(), paused: false, plan: null, subJobs: [], runs: [], moves: [], ...extra };
    return this.change((d) => { d.jobs.push(job); return job; });
  }
  // Approval authorises two things in order: the Jira changes (only if a story
  // still needs a ticket; a fully-keyed plan has nothing to write) and then the
  // implementation. Sub-jobs are only built once every story has its key, since a
  // sub-job's card eyebrow and branch name are that key.
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
  // Every action carries its own fields on the control message, so the payload
  // rides through whole: a move's shape is job-moves.js's business, not a fixed
  // parameter list here.
  action(id, action, payload = {}) {
    const { subJobId, revision, feedback, plan, head, sessionReceiptId } = payload;
    if (action === 'approve-plan') return this.approvePlan(id, revision, plan);
    return this.update(id, (j) => {
      const s = subJobId ? j.subJobs.find((s) => s.id === subJobId) : null;
      if (subJobId && !s) throw new Error('Sub-job not found');
      // `cancel` is Drop's old name and still arrives from an older board.
      const move = action === 'cancel' ? 'drop' : action;
      if (MOVE_ACTIONS.has(move)) {
        const { detail } = applyMove(j, s, move, payload, { now: Date.now(), buildSubJob });
        if (j.plan) j.repos = planRepos(j.plan);
        (j.moves ||= []).push({ id: uid('mv'), at: Date.now(), subJobId: s.id, move, note: payload.note || null, detail });
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
        target.error = null; target.blocked = null;
        if (s) { s.state = s.cancelledAt ? 'cancelled' : 'queued'; s.repairAllowance = (s.repairAllowance || 0) + 1; }
        return;
      }
      if (action === 'revise-session') {
        if (!isSessionSub(s) || s.stage !== 'review' || activeForSub(j, s)) throw new Error('The session result is not ready for review');
        s.feedback = String(feedback || '').trim().slice(0, 8000);
        if (!s.feedback) throw new Error('Explain the requested change');
        s.result = null; s.error = null; s.blocked = null; s.stage = 'session'; s.state = 'queued';
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
      // `publish` is a version-1 phase: a run still live across the upgrade can
      // land the receipt it was launched for.
      const expected = { planning: 'plan', jira: 'jira', implementation: 'published', publish: 'published', repair: 'repaired', verify: 'deployed', session: 'completed' }[r.phase];
      if (report.kind !== expected && report.kind !== 'blocked') throw new Error(`This run must submit ${expected}`);
      const s = j.subJobs.find((s) => s.id === r.subJobId);
      r.report = report; r.reportedAt = Date.now();
      // A receipt racing a cancel is kept on the run for the record but never
      // moves the sub-job: a late `published` must not pull it back out of cleanup.
      if (!s?.cancelledAt) this._applyReceipt(j, r, s, report);
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
      if (j.stage === 'jira') {
        const missing = j.plan.stories.filter((t) => !t.key).map((t) => t.id);
        if (missing.length) throw new Error(`Every story needs a Jira key; still missing: ${missing.join(', ')}`);
        activate(j);
      } else {
        // A New ticket move on a running job: the sub-job waiting on that story
        // gets its key here, which is what releases it to start.
        for (const sub of [...j.subJobs, ...j.plan.subJobs]) {
          if (sub.jiraKey) continue;
          const key = j.plan.stories.find((t) => t.id === sub.storyId)?.key;
          if (key) sub.jiraKey = key;
        }
      }
    }
    // A fresh head (new PR or repair push) is first observed after the comment
    // settle, so reviewers posting seconds after it lands are in that first read.
    if (report.kind === 'published') { s.pr = { url: report.url, checkStatus: 'pending' }; s.stage = 'pr'; s.state = 'watching'; s.note = null; s.nextPollAt = Date.now() + COMMENT_SETTLE_MS; }
    if (report.kind === 'repaired') { s.repairs.push({ ...report, at: Date.now() }); s.state = 'watching'; s.mergeApprovedHead = null; s.pr.checkStatus = 'pending'; s.fixRequested = null; s.note = null; s.nextPollAt = Date.now() + COMMENT_SETTLE_MS; }
    // A session's receipt is the whole deliverable; with review on it waits for a
    // human, otherwise cleanup (archive its session) takes it straight to done.
    if (report.kind === 'completed') { s.result = { ...report, receiptId: r.id, at: Date.now() }; s.feedback = null; s.note = null; s.stage = reviewSessions(j) ? 'review' : 'cleanup'; s.state = reviewSessions(j) ? 'verified' : 'queued'; }
    if (report.kind === 'deployed') { s.deployed = { checks: report.checks, at: Date.now(), commit: s.pr?.mergeCommit || null }; s.stage = 'cleanup'; s.state = 'queued'; }
    // The event box on the card: the agent's own sentence, plus the move it
    // suggests (never applied — a human decides).
    if (report.kind === 'blocked') {
      const target = s || j;
      target.error = report.summary;
      target.blocked = { summary: report.summary, move: report.move || null, phase: r.phase, at: Date.now() };
    }
  }
}
