import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFile } from './job-github.js';
import { removeWorktree, gitRepoRoot, gitMetadataDirs } from './worktree.js';
import { jobPrompt } from './job-prompts.js';

export const expandRepo = (repo) => path.resolve(repo.startsWith('~/') ? path.join(os.homedir(), repo.slice(2)) : repo);
export class JobRuntime {
  constructor({ sessionManager, memoryStore, taskStore }, run = runFile) {
    Object.assign(this, { sessionManager, memoryStore, taskStore, run });
  }
  async launch(job, sub, run, prepared) {
    // Planning discovers its repositories. Blank cwd asks SessionManager for a
    // fresh scratch workspace, without fetching or branching an arbitrary repo.
    const planning = run.phase === 'planning';
    const repo = planning ? '' : expandRepo(sub.repo);
    const existing = sub?.worktree;
    let base = '', cleanupHead = '';
    if (existing && !fs.existsSync(existing.path)) throw new Error('Worktree is missing; restore it before retrying');
    if (!planning && !existing) {
      await this.run('git', ['fetch', 'origin'], repo);
      const remote = JSON.parse(await this.run('gh', ['repo', 'view', '--json', 'defaultBranchRef'], repo));
      base = `refs/remotes/origin/${remote.defaultBranchRef.name}`;
      cleanupHead = await this.run('git', ['rev-parse', '--verify', base], repo);
    }
    // Code lives in the worktree, but fetch/stage/commit also need its shared
    // Git metadata. Recompute for every phase/retry rather than inheriting a
    // previous worker's sandbox or granting the whole main checkout.
    const addDirs = planning ? [path.join(os.homedir(), 'IdeaProjects')]
      : job.agent === 'codex' ? await gitMetadataDirs(existing?.path || repo) : [];
    const result = await this.sessionManager.dispatch({
      cwd: existing?.path || repo, agent: job.agent, model: job.model || undefined,
      intent: jobPrompt(job, sub, run),
      addDirs,
      worktree: !planning && !existing, worktreeAuto: true, worktreeBase: base,
      worktreeBranch: `job-${job.id.slice(-8)}-${sub?.id || 'plan'}`,
      automationRun: { jobId: job.id, subJobId: sub?.id || null, runId: run.id },
      onAutomationPrepared: (sid, wt) => prepared(sid, wt ? { ...wt, cleanupHead } : undefined),
      bindMemory: (sid) => this.memoryStore.bindSession(sid, job.taskId),
    });
    if (job.taskId) this.taskStore.assign(result.sessionId, job.taskId);
    return result;
  }
  async stop(run) {
    if (run.sessionId) {
      await this.sessionManager.suspend(run.sessionId);
      if (await this.isAlive(run)) throw new Error('Session is still running; cannot release its concurrency slot');
      this.retire(run.sessionId);
    }
  }
  // A job step that has stopped is finished for good: the runner never resumes a
  // run, so its card would otherwise sit on the board as dormant clutter, one per
  // phase per sub-job, until the sub-job reached cleanup. Archive sets it aside
  // without losing anything (the mapping, transcript, worktree and Search's
  // archived rows all survive; a human can still Restore it). Only ever called
  // after suspend + a confirmed-not-alive probe, so a working pane is never
  // archived out from under itself. No-op for an already-archived session so a
  // later cleanup sweep can't re-stamp archivedAt and misreport when the step
  // actually stopped; no-op for a purged one so it can't resurrect a phantom.
  retire(sessionId) {
    const { sessionManager: sm } = this;
    if (!sm.entryFor(sessionId) || sm.isArchived(sessionId)) return;
    sm.archive(sessionId, { task: this.taskStore.taskFor(sessionId) });
  }
  async isAlive(run) {
    return this.sessionManager.isSessionAlive(run.sessionId);
  }
  // A headless comment triage has no card of its own; bill it to the sub-job's
  // latest session so the cost scanners see it (they walk priorLiveSessionIds).
  attributeSpend(sub, liveSessionId) {
    const sid = sub.sessions?.at(-1);
    if (sid && liveSessionId) this.sessionManager.recordPriorLiveSessionId(sid, liveSessionId);
  }
  async cleanup(job, sub) {
    // Normally every run is already archived by stop(). This sweep is the backstop
    // for a session bound to a run that never settled cleanly (an interrupted
    // claim, a restart mid-launch).
    for (const sid of sub.sessions || []) {
      await this.sessionManager.suspend(sid);
      this.retire(sid);
    }
    // A cancelled sub-job merged nothing. Its bytes are retained only if the
    // branch was pushed (the PR head) or never left the base it was cut from.
    if (sub.worktree) await this.cleanupWorktree(sub.worktree, sub.cancelledAt ? sub.pr?.head || sub.worktree.cleanupHead : sub.pr.head);
    if (job.updateMain && !sub.cancelledAt) {
      const root = await gitRepoRoot(expandRepo(sub.repo));
      if (!root) throw new Error('Cannot resolve main checkout');
      const dirty = await this.run('git', ['status', '--porcelain'], root);
      const branch = await this.run('git', ['branch', '--show-current'], root);
      if (dirty || branch !== sub.pr.base) throw new Error('Main checkout has local changes or is on another branch; update it manually, then retry');
      await this.run('git', ['fetch', 'origin'], root);
      await this.run('git', ['merge', '--ff-only', `refs/remotes/origin/${sub.pr.base}`], root);
    }
  }
  async cleanupWorktree(wt, expectedHead) {
    if (!expectedHead) throw new Error('Cannot clean up without the verified branch head');
    const ref = `refs/heads/${wt.branch}`;
    if (fs.existsSync(wt.path)) {
      const branch = await this.run('git', ['symbolic-ref', 'HEAD'], wt.path);
      const head = await this.run('git', ['rev-parse', 'HEAD'], wt.path);
      if (branch !== ref || head !== expectedHead) throw new Error('Worktree has changed since verification; preserve it for review');
      const result = await removeWorktree({ worktreePath: wt.path, repoRoot: wt.repoRoot });
      if (!result.ok) throw new Error(`Cleanup needs attention: ${result.reason}`);
    }
    const trees = await this.run('git', ['worktree', 'list', '--porcelain'], wt.repoRoot);
    if (trees.split('\n').includes(`branch ${ref}`)) throw new Error('Branch is in use by another worktree');
    const existing = await this.run('git', ['for-each-ref', '--format=%(objectname)', ref], wt.repoRoot);
    if (!existing) return;
    if (existing !== expectedHead) throw new Error('Branch has additional commits; preserve it for review');
    // The merged PR (or unchanged planning base) proves these exact bytes are
    // retained. Compare-and-delete also refuses a racing local commit.
    await this.run('git', ['update-ref', '-d', ref, expectedHead], wt.repoRoot);
  }
  async cleanupPlanning(job) {
    for (const run of job.runs.filter((r) => r.phase === 'planning' && r.sessionId)) {
      await this.stop(run);
    }
    for (const wt of job.planningWorktrees || []) {
      await this.cleanupWorktree(wt, wt.cleanupHead);
    }
  }
}
