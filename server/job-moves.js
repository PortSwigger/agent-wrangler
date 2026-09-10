import { z } from 'zod';
import { line, id, jira, jiraProject, briefSchema, prUrlSchema, planSchema, isSessionSub } from './jobs-schema.js';
import { COMMENT_SETTLE_MS } from './job-comments.js';

// The six moves a human would make by hand when a job goes wrong. Agents never
// change a plan: a worker's blocked receipt may NAME a move, and this module is
// what a human's click then runs. Pure over the job draft job-store.js is about
// to persist — it validates and mutates that copy, and never touches disk.
const note = line.optional();
const position = z.enum(['before', 'after']);
export const moveSchemas = {
  'fix-here': z.object({ note }),
  'split-out': z.object({ title: line, brief: briefSchema, check: line.optional(), position: position.default('after'), note }),
  'new-ticket': z.object({ storyTitle: line, key: jira.optional(), project: jiraProject.optional(),
    title: line, brief: briefSchema, check: line.optional(), position: position.optional(), note }),
  reorder: z.object({ after: z.array(id).max(30) }),
  drop: z.object({}),
  mark: z.object({ position: z.enum(['pr', 'merged', 'done']), url: prUrlSchema.optional(), note }),
};
export const MOVE_ACTIONS = new Set(Object.keys(moveSchemas));
// Everything but Fix here and Drop rewrites the plan around a sub-job, so it
// cannot land under a session that is working to the old one. Drop is allowed
// live exactly as the cancel it renames was.
const REFUSED_WHILE_LIVE = new Set(['split-out', 'new-ticket', 'reorder', 'mark']);
const UNMERGED = ['implementation', 'pr', 'session'];
const liveRun = (job, subId) => job.runs.some((r) => !r.stopped && r.subJobId === subId);
const quoted = (title) => `“${title}”`;
const both = (job, subId, fn) => {
  fn(job.subJobs.find((s) => s.id === subId));
  const p = job.plan?.subJobs.find((s) => s.id === subId);
  if (p) fn(p);
};
const freeId = (taken, make) => { let n = 2; while (taken.has(make(n))) n++; return make(n); };
// planSchema is the same judge the plan was approved under (unique ids, unknown
// story/dependency, cycles, repo rules), so a move reuses it on a projection of
// the plan and only commits once it passes — nothing here half-edits a plan it
// is about to refuse. A migrated plan may carry a brief longer than today's cap;
// it is not what is being changed, so the throwaway projection trims it rather
// than refusing an unrelated move.
function validatePlan(plan) {
  const projected = { ...plan, subJobs: plan.subJobs.map((s) => ({ ...s, brief: String(s.brief || 'x').slice(0, 500) })) };
  const parsed = planSchema.safeParse(projected);
  if (!parsed.success) throw new Error([...new Set(parsed.error.issues.map((i) => i.message))].join('; '));
}

// The PR sub-job Split out and New ticket both add, validated against the plan
// it would produce (edges included) before anything is committed.
function addPrSubJob(job, sub, data, { storyId, jiraKey, story, position, buildSubJob }) {
  if (isSessionSub(sub)) throw new Error('A session sub-job has no repository to open a PR in');
  const taken = new Set(job.plan.subJobs.map((s) => s.id));
  const spec = { id: freeId(taken, (n) => `${sub.id}-${n}`), title: data.title, kind: 'pr', repo: sub.repo,
    storyId, after: [], brief: data.brief, ...(data.check ? { check: data.check } : {}), ...(jiraKey ? { jiraKey } : {}) };
  const projected = { ...job.plan, stories: [...job.plan.stories, ...(story ? [story] : [])],
    subJobs: [...job.plan.subJobs.map((s) => ({ ...s })), spec] };
  if (position === 'before') { const p = projected.subJobs.find((s) => s.id === sub.id); p.after = [...p.after, spec.id]; }
  else if (position === 'after') spec.after = [sub.id];
  validatePlan(projected);
  if (story) job.plan.stories.push(story);
  job.plan.subJobs.push(spec);
  job.subJobs.push(buildSubJob(job.plan, spec));
  if (position === 'before') both(job, sub.id, (s) => { s.after = [...s.after, spec.id]; });
  return spec;
}
// A sub-job whose plan just changed goes back to work: the same retry semantics
// the Retry button carries, including the extra repair attempt.
function requeue(sub) {
  sub.error = null; sub.blocked = null;
  sub.state = ['pr', 'deployment'].includes(sub.stage) ? 'watching' : 'queued';
  sub.nextPollAt = 0; sub.repairAllowance = (sub.repairAllowance || 0) + 1;
}

export function applyMove(job, sub, move, payload, { now = Date.now(), buildSubJob }) {
  const schema = moveSchemas[move];
  if (!schema) throw new Error('Unknown job action');
  if (!sub) throw new Error('Choose a sub-job');
  if (sub.stage === 'done' || sub.cancelledAt) throw new Error('Sub-job has already finished');
  const data = schema.parse(payload);
  if (liveRun(job, sub.id) && REFUSED_WHILE_LIVE.has(move)) throw new Error('Wait for the session to stop');

  if (move === 'fix-here') {
    if (sub.stage === 'pr') {
      if (liveRun(job, sub.id)) throw new Error('Wait for the session to stop');
      // Deliberately independent of checkStatus: the human has seen something
      // green checks do not cover, so the next tick launches a repair anyway.
      sub.fixRequested = { note: data.note || null, at: now };
      sub.error = null; sub.blocked = null; sub.state = 'watching'; sub.nextPollAt = 0;
      sub.repairAllowance = (sub.repairAllowance || 0) + 1;
      return { detail: `Asked for a new commit on ${quoted(sub.title)}` };
    }
    if (sub.stage === 'implementation' || sub.stage === 'session') {
      sub.note = data.note || null;
      sub.error = null; sub.blocked = null; sub.state = 'queued';
      return { detail: `Ran ${quoted(sub.title)} again` };
    }
    // Merged: a new commit on this PR is no longer possible, and the fix is a
    // new PR — which is exactly Split out.
    throw new Error('This PR has merged; Split out a follow-up PR instead');
  }

  if (move === 'split-out') {
    if (isSessionSub(sub)) throw new Error('A session sub-job has no repository to open a PR in');
    if (!['implementation', 'pr', 'deployment'].includes(sub.stage)) throw new Error('Nothing left to split out of this sub-job');
    const merged = sub.stage === 'deployment';
    // A merged sub-job cannot wait for anything, and the dependants already wait
    // on it, so the fix simply lands where it is: position has nothing to order.
    const spec = addPrSubJob(job, sub, data, { storyId: sub.storyId, jiraKey: sub.jiraKey || null, buildSubJob,
      position: merged ? null : data.position });
    if (merged) {
      // The fix lands before the dependants, which already wait on this one: it
      // counts as deployed the moment its fix does (job-runner.js).
      sub.recoveredBy = spec.id; sub.state = 'awaiting-fix'; sub.nextPollAt = 0;
      sub.error = null; sub.blocked = null;
    } else requeue(sub);
    if (data.note) sub.note = data.note;
    return { detail: merged ? `Split out ${quoted(spec.title)} as the fix for this merged PR`
      : `Split out ${quoted(spec.title)} to land ${data.position} this` };
  }

  if (move === 'new-ticket') {
    const taken = new Set(job.plan.stories.map((s) => s.id));
    // Keyless unless the human already made the ticket: the runner then runs the
    // ordinary Jira step for it, and the new sub-job waits for that key.
    const story = { id: freeId(taken, (n) => `s-${n}`), ...(data.key ? { key: data.key } : {}),
      ...(data.project ? { project: data.project } : {}), title: data.storyTitle };
    const spec = addPrSubJob(job, sub, data, { storyId: story.id, jiraKey: data.key || null, story, buildSubJob,
      position: UNMERGED.includes(sub.stage) ? data.position : null });
    sub.error = null; sub.blocked = null;
    if (data.note) sub.note = data.note;
    return { detail: `New ticket ${quoted(story.title)} with PR ${quoted(spec.title)}${data.position ? ` to land ${data.position} this` : ''}` };
  }

  if (move === 'reorder') {
    if (!UNMERGED.includes(sub.stage)) throw new Error('This sub-job has merged; its order can no longer change');
    if (data.after.includes(sub.id)) throw new Error('A sub-job cannot depend on itself');
    validatePlan({ ...job.plan, subJobs: job.plan.subJobs.map((s) => (s.id === sub.id ? { ...s, after: [...data.after] } : s)) });
    both(job, sub.id, (s) => { s.after = [...data.after]; });
    const titles = data.after.map((x) => job.subJobs.find((s) => s.id === x)?.title || x);
    return { detail: titles.length ? `Now lands after ${titles.map(quoted).join(' · ')}` : 'No longer waits for anything' };
  }

  if (move === 'drop') {
    if (sub.stage === 'cleanup') throw new Error('Sub-job has already finished');
    // Straight to cleanup. The runner stops any live step; nothing merged, so
    // cleanup keeps every commit it cannot prove is retained elsewhere.
    sub.cancelledAt = now; sub.stage = 'cleanup'; sub.state = 'cancelled';
    sub.error = null; sub.blocked = null; sub.observationError = null;
    return { detail: `Dropped ${quoted(sub.title)}` };
  }

  if (move === 'mark') {
    if (data.position === 'pr') {
      if (sub.pr || sub.stage !== 'implementation') throw new Error('This sub-job already has a PR');
      if (!data.url) throw new Error('Give the PR url');
      sub.pr = { url: data.url, checkStatus: 'pending' }; sub.stage = 'pr'; sub.state = 'watching';
      sub.error = null; sub.blocked = null; sub.nextPollAt = now + COMMENT_SETTLE_MS;
      return { detail: `Marked as PR ${data.url}` };
    }
    if (data.position === 'merged') {
      if (sub.stage !== 'pr') throw new Error('Only an open PR can be marked merged');
      // No stage jump: the very next poll reads the merge commit and takes the
      // ordinary MERGED branch, which is also what decides whether the merge is
      // itself the delivery. Marking only unblocks and hurries that poll.
      sub.error = null; sub.blocked = null; sub.state = 'watching'; sub.nextPollAt = 0;
      return { detail: 'Marked merged by hand' };
    }
    if (sub.stage === 'cleanup') throw new Error('Sub-job has already finished');
    const checks = [data.note || 'Marked done by hand'];
    if (isSessionSub(sub)) sub.result = { checks, at: now, receiptId: null };
    else sub.deployed = { at: now, checks, commit: sub.pr?.mergeCommit || null };
    sub.error = null; sub.blocked = null; sub.stage = 'cleanup'; sub.state = 'queued';
    return { detail: `Marked done: ${checks[0]}` };
  }
  throw new Error('Unknown job action');
}
