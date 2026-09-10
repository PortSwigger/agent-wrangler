import { runnable, dependencySatisfied, dependenciesSatisfied, sessionDependenciesDone, MERGE_IS_DELIVERY } from './job-store.js';
import { summariseComments, commentsBlockMerge } from './job-comments.js';
import { logWarn } from './log.js';
const shortError = (e) => String(e?.message || e).split('\n')[0].slice(0, 240);
const activeFor = (j, s) => j.runs.some((r) => runnable(r) && r.subJobId === (s?.id || null));
// A worker that stopped WORKING without reporting has finished in the only sense
// this runner can observe. The grace is long because "idle" is also what a
// session looks like between a tool call and its answer, and a false error here
// costs a human a retry; a real one only ever delays the same error.
export const IDLE_RECEIPT_GRACE_MS = 10 * 60 * 1000;

// One process owns the store (the existing DATA_DIR instance lock). Claims are
// durable before launch; an uncertain launch is blocked on restart, never replayed.
export class JobRunner {
  constructor({ store, runtime, github, onChange = async () => {}, now = Date.now, summarise = summariseComments, statusOf = () => null }) {
    Object.assign(this, { store, runtime, github, onChange, now, summarise, statusOf });
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
  // No clock runs against a session: a long step is legitimate work, and a
  // needs-you one is surfaced on the board rather than killed. What ends a run
  // is its receipt, its process, or having stopped working without either.
  async settle(id) {
    for (const run of this.store.get(id).runs.filter(runnable)) {
      let error;
      const cancelled = run.subJobId && this.store.get(id).subJobs.find((s) => s.id === run.subJobId)?.cancelledAt;
      if (!run.report && !cancelled) {
        if (!run.sessionId) error = 'Launch was interrupted. Check for an existing session/worktree before retrying.';
        else if (!(await this.runtime.isAlive(run))) error = 'Session stopped without a receipt. Open it to see why, then retry.';
        else {
          await this.answerDialogs(run);
          const idleSince = this.statusOf(run.sessionId) === 'idle' ? (run.idleSince ?? this.now()) : null;
          // Written only on the edge: the graph rebuild reads this file, so a
          // per-tick rewrite would broadcast a whole snapshot every few seconds.
          if (idleSince !== (run.idleSince ?? null)) this.patchRun(id, run.id, (r) => { r.idleSince = idleSince; });
          if (!idleSince || this.now() - idleSince <= IDLE_RECEIPT_GRACE_MS) continue;
          error = 'Session finished without a receipt. Open it to see why, then retry.';
        }
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
  patchRun(jobId, runId, fn) { return this.store.update(jobId, (j) => fn(j.runs.find((r) => r.id === runId))); }
  // A live, unreported worker may be parked on Claude's trust dialog rather than
  // working (job-runtime.js acceptTrustDialog). Best-effort: a tmux hiccup here
  // must not fail a run that is otherwise fine, so the error is logged, not raised.
  async answerDialogs(run) {
    try { await this.runtime.acceptTrustDialog?.(run); } catch (e) { logWarn('[jobs] trust dialog', run.sessionId, shortError(e)); }
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
  async advance(id) {
    let job = this.store.get(id);
    if (!this.allowed(id) || job.error) return;
    if (job.stage === 'planning' && !job.plan && !activeFor(job)) { await this.launch(job, null, 'planning'); return; }
    if (job.stage === 'jira' && !activeFor(job)) { await this.launch(job, null, 'jira'); return; }
    if (job.stage !== 'active') return;
    // A New ticket move can add a keyless story to a running job: ticketing is
    // the same step, run again, and the sub-job waiting on that key starts once
    // its receipt lands (job-store.js).
    if (job.plan?.stories.some((s) => !s.key) && !activeFor(job)) {
      await this.launch(job, null, 'jira');
      job = this.store.get(id);
    }
    for (const initial of job.subJobs) {
      job = this.store.get(id);
      if (!this.allowed(id) || job.error) return;
      let sub = job.subJobs.find((s) => s.id === initial.id);
      if (activeFor(job, sub)) continue;
      if (sub.error) continue;
      try {
        if (sub.stage === 'session') {
          if (dependenciesSatisfied(job, sub)) await this.launch(job, sub, 'session');
        } else if (sub.stage === 'implementation') {
          // One session per PR: work, commit, push, open the PR. PR
          // prerequisites gate the MERGE, not the start, so building can happen
          // in parallel; only a session prerequisite's output is an input.
          if (sub.jiraKey && sessionDependenciesDone(job, sub)) await this.launch(job, sub, 'implementation');
        } else if (sub.stage === 'pr') {
          if (sub.nextPollAt > this.now()) continue;
          const pr = await this.github.pr(sub);
          const comments = await this.github.comments(sub);
          // Whether this diff deploys is a property of the head, so it is read
          // once per head and again after every repair push.
          const deploys = !sub.deploys || sub.deploys.head !== pr.head ? await this.github.deploys(sub, pr) : sub.deploys;
          this.patchSub(id, sub.id, (s) => { s.pr = pr; s.prComments = comments; s.deploys = deploys; s.observationError = null; s.nextPollAt = this.now() + 30000; });
          this.triage(id, sub.id);
          if (!this.allowed(id)) continue;
          job = this.store.get(id); sub = job.subJobs.find((s) => s.id === sub.id);
          if (pr.state === 'MERGED') {
            // Nothing runs on push for these paths, so the merge IS the
            // delivery: mark it deployed to release dependants, without waiting
            // for a workflow run that can never appear.
            this.patchSub(id, sub.id, (s) => {
              s.mergedAt = this.now();
              if (!s.deploys?.expected) { s.deployed = { at: this.now(), checks: [MERGE_IS_DELIVERY], commit: pr.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; }
              else { s.stage = 'deployment'; s.state = 'watching'; s.nextPollAt = 0; }
            });
          } else if (pr.state === 'CLOSED') {
            this.patchSub(id, sub.id, (s) => { s.error = 'PR was closed without merging'; });
          } else if (sub.fixRequested) {
            // The human saw something the checks do not cover; the repair runs
            // whatever colour they are.
            await this.launch(job, sub, 'repair');
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
        } else if (sub.stage === 'deployment' && sub.recoveredBy) {
          // Split out from a merged sub-job: it counts as deployed the moment
          // its fix does, and goes to cleanup exactly as a watched one would.
          const fix = job.subJobs.find((s) => s.id === sub.recoveredBy);
          if (fix?.cancelledAt) this.patchSub(id, sub.id, (s) => { s.error = `The fix sub-job (${fix.title}) was cancelled`; });
          else if (dependencySatisfied(fix)) this.patchSub(id, sub.id, (s) => { s.deployed = { at: this.now(), checks: [`Fixed by ${fix.title}`], commit: s.pr?.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; });
        } else if (sub.stage === 'deployment') {
          if (sub.nextPollAt > this.now()) continue;
          const result = await this.github.deployment(sub);
          const staleMs = this.store.snapshot().settings.deploymentStaleMinutes * 60000;
          this.patchSub(id, sub.id, (s) => {
            s.deploymentResult = result; s.observationError = null; s.nextPollAt = this.now() + 30000;
            // NOTHING running this long after the merge means the workflows said
            // this push deploys and GitHub disagrees — nothing triggered, or
            // everything that did was skipped. Silence can never be read as
            // success (it is indistinguishable from a run not yet queued), so it
            // goes to the human rather than completing the sub-job. A run in
            // progress is just a slow deploy and is never stale. Pre-existing
            // sub-jobs have no mergedAt; count from their first observation.
            s.mergedAt ??= this.now();
            const silent = result.status === 'pending' && !result.runs.some((r) => r.status !== 'skipped');
            s.deploymentStale = silent && this.now() - s.mergedAt > staleMs ? { since: s.mergedAt } : null;
          });
          if (!this.allowed(id)) continue;
          job = this.store.get(id); sub = job.subJobs.find((s) => s.id === sub.id);
          // The ladder ends here unless the plan named a check no pipeline can
          // perform; that one line is the only thing a verify session exists for.
          if (result.status === 'passing') {
            if (sub.check) await this.launch(job, sub, 'verify');
            else this.patchSub(id, sub.id, (s) => { s.deployed = { at: this.now(), checks: ['Post-merge runs passed'], commit: s.pr?.mergeCommit }; s.stage = 'cleanup'; s.state = 'queued'; });
          } else if (result.status === 'failing') {
            const failed = result.runs.filter((r) => r.status === 'failing').map((r) => r.workflow).join(', ');
            this.patchSub(id, sub.id, (s) => { s.error = `Post-merge run failed: ${failed || 'unknown workflow'}`; });
          }
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
