import crypto from 'node:crypto';
import { runnable, dependenciesSatisfied, sessionDependenciesDone } from './job-store.js';
import { summariseComments, commentsBlockMerge } from './job-comments.js';
const shortError = (e) => String(e?.message || e).split('\n')[0].slice(0, 240);
const activeFor = (j, s) => j.runs.some((r) => runnable(r) && r.subJobId === (s?.id || null));

// One process owns the store (the existing DATA_DIR instance lock). Claims are
// durable before launch; an uncertain launch is blocked on restart, never replayed.
export class JobRunner {
  constructor({ store, runtime, github, onChange = async () => {}, now = Date.now, summarise = summariseComments }) {
    Object.assign(this, { store, runtime, github, onChange, now, summarise });
    this.busy = false;
    this.triaging = new Map(); this.pending = new Set();
  }
  // Every in-flight comment triage has settled (tests; the poll never waits).
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    const before = this.store.data;
    try {
      for (const job of this.store.snapshot().jobs) {
        try {
          await this.settle(job.id);
          await this.advance(job.id);
        } catch (e) { this.store.update(job.id, (j) => { j.error = shortError(e); }); }
      }
    } finally { this.busy = false; if (before !== this.store.data) await this.onChange(); }
  }
  patchSub(jobId, subId, fn) { return this.store.update(jobId, (j) => fn(j.subJobs.find((s) => s.id === subId), j)); }
  allowed(id) { const d = this.store.snapshot(); return !d.settings.paused && !d.jobs.find((j) => j.id === id)?.paused; }
  async settle(id) {
    const timeout = this.store.snapshot().settings.maxRunMinutes * 60000;
    for (const run of this.store.get(id).runs.filter(runnable)) {
      let error;
      const cancelled = run.subJobId && this.store.get(id).subJobs.find((s) => s.id === run.subJobId)?.cancelledAt;
      if (!run.report && !cancelled) {
        if (!run.sessionId) error = 'Launch was interrupted. Check for an existing session/worktree before retrying.';
        else if (this.now() - run.startedAt > timeout) error = 'Session exceeded its time limit. Review its work and retry.';
        else if (!(await this.runtime.isAlive(run))) error = 'Session stopped without a verification receipt. Review its work and retry.';
        else continue;
      }
      // A receipt can arrive while the process probe is awaiting tmux. Honour
      // that durable report even if the worker has already exited afterwards.
      if (error && this.store.get(id).runs.find((r) => r.id === run.id)?.report) error = undefined;
      try {
        await this.runtime.stop(run);
        this.store.update(id, (j) => {
          const r = j.runs.find((r) => r.id === run.id);
          r.stopped = true; r.stoppedAt = this.now();
          const s = j.subJobs.find((s) => s.id === r.subJobId);
          if (error) (s || j).error = error;
        });
      } catch (e) {
        this.store.update(id, (j) => { j.error = shortError(e); });
      }
    }
  }
  // Classify the current comment set once per fingerprint, off the poll: a
  // Haiku call takes seconds and the tick must not stall other jobs on it. The
  // verdict lands only if the comments it read are still the current ones;
  // otherwise the next poll re-triages against the newer set.
  triage(id, subId) {
    const sub = this.store.get(id)?.subJobs.find((s) => s.id === subId);
    const comments = sub?.prComments;
    if (!comments?.items.length) {
      if (sub?.commentSummary) this.patchSub(id, subId, (s) => { s.commentSummary = null; });
      return;
    }
    const key = `${id}/${subId}`;
    if (sub.commentSummary?.fingerprint === comments.fingerprint || this.triaging.get(key)?.fingerprint === comments.fingerprint) return;
    const done = this.summarise(comments, sub.pr)
      .catch((e) => ({ tone: 'amber', text: `Summary unavailable (${shortError(e)}). Read the comments yourself before merging.`, error: true }))
      .then(async ({ tone, text, error, liveSessionId }) => {
        if (this.triaging.get(key)?.fingerprint === comments.fingerprint) this.triaging.delete(key);
        const current = this.store.get(id)?.subJobs.find((s) => s.id === subId);
        if (!current) return;
        if (liveSessionId) this.runtime.attributeSpend(current, liveSessionId);
        if (current.prComments?.fingerprint !== comments.fingerprint) return;
        this.patchSub(id, subId, (s) => { s.commentSummary = { fingerprint: comments.fingerprint, tone, text, error: !!error, at: this.now() }; });
        await this.onChange();
      }).catch((e) => console.error('[jobs] comment triage', e)).finally(() => this.pending.delete(done));
    this.triaging.set(key, { fingerprint: comments.fingerprint }); this.pending.add(done);
  }
  async launch(job, sub, phase) {
    const run = this.store.claim(job.id, sub?.id || null, phase);
    if (!run) return;
    try {
      await this.runtime.launch(job, sub, run, (sessionId, wt) => this.store.bindRun(job.id, run.id, sessionId, wt));
    } catch (e) {
      const latest = this.store.get(job.id).runs.find((r) => r.id === run.id);
      // Even a launch error may have created a process. Stop before releasing.
      await this.runtime.stop(latest);
      this.store.update(job.id, (j) => {
        j.runs.find((r) => r.id === run.id).stopped = true;
        (j.subJobs.find((s) => s.id === sub?.id) || j).error = shortError(e);
      });
    }
  }
  async recover(job, sub, reason) {
    if (sub.recoveryJobId) {
      const recovery = this.store.get(sub.recoveryJobId);
      if (recovery?.stage === 'done') this.patchSub(job.id, sub.id, (s) => {
        s.deployed = { at: this.now(), checks: [`Verified by recovery job: ${recovery.title}`], recoveryJobId: recovery.id };
        s.error = null; s.stage = 'cleanup'; s.state = 'queued';
      });
      return;
    }
    // Store the recovery job and backlink atomically: no duplicate tickets/jobs
    // if the service stops between observing the failure and the next poll.
    this.store.change((d) => {
      const j = d.jobs.find((j) => j.id === job.id), s = j.subJobs.find((s) => s.id === sub.id);
      if (s.recoveryJobId) return;
      const id = `job_${crypto.randomBytes(8).toString('hex')}`;
      d.jobs.push({ ...job, id, title: `Recover: ${sub.title}`.slice(0, 180),
        intent: `Recover the failed deployment of ${sub.title}. ${reason}\nPR: ${sub.pr.url}\nMerge commit: ${sub.pr.mergeCommit}\nOriginal goal: ${job.intent}\nReuse Jira story ${sub.jiraKey}. Diagnose first and propose the smallest independently verifiable fix.`,
        repos: [sub.repo], stage: 'backlog', plan: null, subJobs: [], runs: [], planningWorktrees: [],
        error: null, paused: false, revision: 0, createdAt: this.now(), updatedAt: this.now(),
        recoveryOf: { jobId: job.id, subJobId: sub.id }, feedback: null,
      });
      s.recoveryJobId = id; s.error = reason; s.state = 'recovery'; j.revision++;
    });
  }
  async advance(id) {
    let job = this.store.get(id);
    if (!this.allowed(id) || job.error) return;
    if (job.stage === 'planning' && !job.plan && !activeFor(job)) { await this.launch(job, null, 'planning'); return; }
    if (job.stage !== 'active') return;
    for (const initial of job.subJobs) {
      job = this.store.get(id);
      if (!this.allowed(id) || job.error) return;
      let sub = job.subJobs.find((s) => s.id === initial.id);
      if (activeFor(job, sub)) continue;
      if (sub.recoveryJobId && sub.stage === 'deployment') { await this.recover(job, sub, sub.error); continue; }
      // A deployed-behaviour failure is a recovery proposal too, not an agent
      // silently pushing fixes straight back into production.
      if (sub.error && sub.stage === 'deployment' && job.runs.some((r) => r.subJobId === sub.id && r.phase === 'verify' && r.report?.kind === 'blocked')) {
        await this.recover(job, sub, sub.error); continue;
      }
      if (sub.error) continue;
      try {
        if (sub.stage === 'session') {
          if (dependenciesSatisfied(job, sub)) await this.launch(job, sub, 'session');
        } else if (sub.stage === 'implementation') {
          if (!sub.local) { if (sessionDependenciesDone(job, sub)) await this.launch(job, sub, 'implementation'); }
          else if (dependenciesSatisfied(job, sub)) {
            if (!sub.dependenciesVerified) await this.launch(job, sub, 'implementation');
            else if (!job.reviewCode || sub.codeApprovedAt) await this.launch(job, sub, 'publish');
          }
        } else if (sub.stage === 'pr') {
          if (sub.nextPollAt > this.now()) continue;
          const pr = await this.github.pr(sub);
          const comments = await this.github.comments(sub);
          this.patchSub(id, sub.id, (s) => { s.pr = pr; s.prComments = comments; s.observationError = null; s.nextPollAt = this.now() + 30000; });
          this.triage(id, sub.id);
          if (!this.allowed(id)) continue;
          job = this.store.get(id); sub = job.subJobs.find((s) => s.id === sub.id);
          if (pr.state === 'MERGED') {
            this.patchSub(id, sub.id, (s) => { s.stage = 'deployment'; s.state = 'watching'; s.nextPollAt = 0; });
          } else if (pr.state === 'CLOSED') {
            this.patchSub(id, sub.id, (s) => { s.error = 'PR was closed without merging'; });
          } else if (pr.checkStatus === 'failing') {
            const attempts = job.runs.filter((r) => r.subJobId === sub.id && r.phase === 'repair').length;
            const limit = this.store.snapshot().settings.maxRepairs + (sub.repairAllowance || 0);
            if (attempts >= limit) this.patchSub(id, sub.id, (s) => { s.error = 'Automatic repair limit reached. Review changes, then retry if needed.'; });
            else await this.launch(job, sub, 'repair');
          } else if (pr.checkStatus === 'passing' && dependenciesSatisfied(job, sub) && (sub.mergeApprovedHead === pr.head || (!job.reviewMerge && !commentsBlockMerge(sub)))) {
            // Match-head on GitHub closes the push-vs-merge race; re-poll after
            // success instead of pretending an accepted merge-queue entry merged.
            if (sub.mergeRequestedHead !== pr.head) {
              await this.github.merge(sub, { canMerge: () => this.allowed(id) });
              this.patchSub(id, sub.id, (s) => { s.mergeRequestedHead = pr.head; });
            }
          }
        } else if (sub.stage === 'deployment') {
          if (sub.nextPollAt > this.now()) continue;
          const result = await this.github.deployment(sub);
          this.patchSub(id, sub.id, (s) => { s.deploymentResult = result; s.observationError = null; s.nextPollAt = this.now() + 30000; });
          if (!this.allowed(id)) continue;
          sub = this.store.get(id).subJobs.find((s) => s.id === sub.id);
          if (result.status === 'passing') await this.launch(this.store.get(id), sub, 'verify');
          else if (result.status === 'failing') await this.recover(this.store.get(id), sub, 'Deployment workflow failed. Review the linked recovery job.');
        } else if (sub.stage === 'cleanup') {
          await this.runtime.cleanup(job, sub);
          this.patchSub(id, sub.id, (s) => { s.stage = 'done'; s.state = s.cancelledAt ? 'cancelled' : 'done'; });
        }
      } catch (e) {
        this.patchSub(id, sub.id, (s) => {
          if (s.stage === 'cleanup') s.error = shortError(e);
          else { s.observationError = shortError(e); s.nextPollAt = this.now() + 60000; }
        });
      }
    }
    job = this.store.get(id);
    if (job.subJobs.length && job.subJobs.every((s) => s.stage === 'done')) {
      try {
        await this.runtime.cleanupPlanning(job);
        this.store.update(id, (j) => { j.stage = 'done'; j.completedAt = this.now(); });
      } catch (e) { this.store.update(id, (j) => { j.error = shortError(e); }); }
    }
  }
}
