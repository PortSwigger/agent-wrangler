import os from 'node:os';
import { planSchema, isSessionSub } from './jobs-schema.js';

// Pure rules for amending an approved plan (jobs-schema.js amendmentOpSchema):
// project the live sub-jobs back to plan fields, apply the ops to the projection,
// and let planSchema judge the result so uniqueness, cycles and repo rules are
// the same ones the plan was approved under. Stage gates then say whether each
// op still makes sense for where its sub-job has got to. Nothing here mutates
// the job — job-store.js applies an amendment only after this has passed, and
// re-runs it at acceptance because the job has moved on since the proposal.
const PLAN_FIELDS = ['id', 'title', 'kind', 'repo', 'storyId', 'jiraKey', 'dependsOn', 'instructions', 'deployment'];
const projection = (sub) => Object.fromEntries(PLAN_FIELDS.filter((k) => sub[k] != null).map((k) => [k, structuredClone(sub[k])]));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const setDiff = (before, after) => ({ added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) });
const open = (s) => s && s.stage !== 'done' && !s.cancelledAt;
// A dependency can move until the sub-job merges (a session's receipt is its
// merge); instructions and pending checks only before it publishes.
const BEFORE_MERGE = ['implementation', 'pr', 'session'];
const BEFORE_PUBLISH = ['implementation', 'session'];
const tildify = (p) => typeof p === 'string' && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;

// The sub-jobs an amendment touches, plus the one it was proposed from: that is
// what "a run is live on a targeted sub-job" and Needs me are judged against.
export const amendmentTargets = (a) => [...new Set([...a.ops.map((o) => o.subJobId), a.subJobId].filter(Boolean))];

// Tightening only ever adds a constraint (a wait, a deployment, a check), so it can
// never let work through that the approved plan would have held; weakening can.
// Neutral covers text and additive-but-costly changes, which need a human below
// 'auto' because they spend money or restart work rather than because they let
// anything slip.
export function classifyOp(job, op) {
  const s = job.subJobs.find((x) => x.id === op.subJobId);
  const grade = ({ added, removed }) => removed.length ? 'weakening' : added.length ? 'tightening' : 'neutral';
  switch (op.op) {
    case 'add-dependency': return 'tightening';
    case 'remove-dependency': return 'weakening';
    // Deployment is now presence, not a list: adding a wait for a deployment can
    // only hold work back, dropping one lets a merge complete the sub-job on its
    // own, and rewriting the verification text is neither.
    case 'set-deployment': return !s?.deployment && op.deployment ? 'tightening' : s?.deployment && !op.deployment ? 'weakening' : 'neutral';
    case 'set-pending-checks': return grade(setDiff(s?.local?.pendingChecks || [], op.pendingChecks));
    default: return 'neutral';
  }
}
export function classifyAmendment(job, ops) {
  const kinds = ops.map((o) => classifyOp(job, o));
  return kinds.includes('weakening') ? 'weakening' : kinds.every((k) => k === 'tightening') ? 'tightening' : 'neutral';
}
export const authorityPermits = (authority, classification) => authority === 'auto' || (authority === 'auto-tighten' && classification === 'tightening');

export function validateAmendment(job, ops) {
  if (job.stage !== 'active') return { ok: false, error: 'The plan can only be amended while the job is active' };
  const stories = job.plan?.stories || [];
  const subs = job.subJobs.map(projection);
  const live = new Map(job.subJobs.map((s) => [s.id, s]));
  const fail = (i, op, msg) => ({ ok: false, error: `Change ${i + 1} (${op.op}${op.subJobId ? ` on ${live.get(op.subJobId)?.title || op.subJobId}` : ''}): ${msg}` });
  for (const [i, op] of ops.entries()) {
    if (op.op === 'add-sub-job') {
      const { spec } = op;
      if (subs.some((s) => s.id === spec.id)) return fail(i, op, `a sub-job with id ${spec.id} already exists`);
      const story = stories.find((t) => t.id === spec.storyId);
      if (!story) return fail(i, op, `unknown story ${spec.storyId}`);
      if (!spec.jiraKey && !story.key) return fail(i, op, `story ${story.id} has no Jira key yet; an added sub-job needs jiraKey (this does not create stories)`);
      subs.push(projection(spec)); continue;
    }
    const s = live.get(op.subJobId), p = subs.find((x) => x.id === op.subJobId);
    if (!s) return fail(i, op, 'no such sub-job');
    if (!open(s)) return fail(i, op, s.cancelledAt ? 'the sub-job was cancelled' : 'the sub-job is finished');
    if (op.op === 'add-dependency' || op.op === 'remove-dependency') {
      if (!BEFORE_MERGE.includes(s.stage)) return fail(i, op, 'dependencies can only change before the sub-job merges');
      const has = p.dependsOn.includes(op.dependsOn);
      if (op.op === 'add-dependency') {
        if (op.dependsOn === s.id) return fail(i, op, 'a sub-job cannot depend on itself');
        if (has) return fail(i, op, `already depends on ${op.dependsOn}`);
        p.dependsOn = [...p.dependsOn, op.dependsOn];
      } else {
        if (!has) return fail(i, op, `does not depend on ${op.dependsOn}`);
        p.dependsOn = p.dependsOn.filter((d) => d !== op.dependsOn);
      }
    } else if (op.op === 'set-deployment') {
      if (isSessionSub(s)) return fail(i, op, 'a session sub-job has no deployment');
      if (s.deployed) return fail(i, op, 'already deployed');
      if (!['implementation', 'pr', 'deployment'].includes(s.stage)) return fail(i, op, 'the deployment can only change before the sub-job is deployed');
      if (same(p.deployment, op.deployment)) return fail(i, op, 'no change');
      if (op.deployment) p.deployment = op.deployment; else delete p.deployment;
    } else if (op.op === 'set-pending-checks') {
      if (isSessionSub(s)) return fail(i, op, 'a session sub-job has no PR checks');
      if (s.stage !== 'implementation') return fail(i, op, 'pending checks can only change during implementation');
      if (!s.local) return fail(i, op, 'no local receipt yet; report pending checks with it');
      if (same(s.local.pendingChecks || [], op.pendingChecks)) return fail(i, op, 'no change');
    } else if (op.op === 'set-instructions') {
      if (!BEFORE_PUBLISH.includes(s.stage)) return fail(i, op, 'instructions can only change during implementation');
      if (p.instructions === op.instructions) return fail(i, op, 'no change');
      p.instructions = op.instructions;
    } else if (op.op === 'set-recovered-by') {
      if (isSessionSub(s) || s.stage !== 'deployment') return fail(i, op, 'only a merged sub-job whose deployment failed can be recovered');
      if (s.recoveryJobId) return fail(i, op, 'a recovery job already exists for it');
      if (s.recoveredBy) return fail(i, op, `already recovered by ${s.recoveredBy}`);
      if (op.fixSubJobId === s.id) return fail(i, op, 'a sub-job cannot recover itself');
      if (!subs.some((x) => x.id === op.fixSubJobId)) return fail(i, op, `no such sub-job ${op.fixSubJobId}`);
      const fix = live.get(op.fixSubJobId);
      if (fix && !open(fix)) return fail(i, op, 'the fix sub-job is finished');
    }
  }
  const parsed = planSchema.safeParse({ stories, subJobs: subs });
  if (!parsed.success) return { ok: false, error: `The amended plan is invalid: ${[...new Set(parsed.error.issues.map((x) => x.message))].join('; ')}` };
  return { ok: true, plan: parsed.data, targets: amendmentTargets({ ops }), classification: classifyAmendment(job, ops) };
}

// Plain-language diff lines, computed at proposal time against the plan as it
// then stood: the "was" side is gone once the amendment is applied, and a human
// reading the history later needs it. Rendered with esc() client-side.
export function describeAmendment(job, ops) {
  const title = (id) => job.subJobs.find((s) => s.id === id)?.title || ops.find((o) => o.op === 'add-sub-job' && o.spec.id === id)?.spec.title || id;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return ops.map((op) => {
    const s = job.subJobs.find((x) => x.id === op.subJobId);
    switch (op.op) {
      case 'add-sub-job': return `Add ${isSessionSub(op.spec) ? 'session' : 'PR'} sub-job “${op.spec.title}”${op.spec.repo ? ` in ${tildify(op.spec.repo)}` : ''}${op.spec.dependsOn.length ? `, after ${op.spec.dependsOn.map(title).join(' + ')}` : ''}`;
      case 'add-dependency': return `${title(op.subJobId)} now ${isSessionSub(s) ? 'starts' : 'deploys'} after ${title(op.dependsOn)}`;
      case 'remove-dependency': return `${title(op.subJobId)} no longer waits for ${title(op.dependsOn)}`;
      case 'set-deployment':
        if (!op.deployment) return `Drop deployment for ${title(op.subJobId)}: merging completes it`;
        if (!s?.deployment) return `Wait for a deployment of ${title(op.subJobId)}, then verify: ${op.deployment.verify}`;
        return `New verification for ${title(op.subJobId)}: ${op.deployment.verify}`;
      case 'set-pending-checks': {
        const { added, removed } = setDiff(s?.local?.pendingChecks || [], op.pendingChecks);
        return [removed.length ? `Remove ${plural(removed.length, 'pending check')} from ${title(op.subJobId)}: ${removed.join(' · ')}` : '',
          added.length ? `Add ${plural(added.length, 'pending check')} to ${title(op.subJobId)}: ${added.join(' · ')}` : ''].filter(Boolean).join('. ') || `Pending checks for ${title(op.subJobId)} unchanged`;
      }
      case 'set-instructions': return `Rewrite the instructions for ${title(op.subJobId)}; its implementation starts again`;
      case 'set-recovered-by': return `${title(op.subJobId)} counts as deployed once ${title(op.fixSubJobId)} deploys`;
      default: return op.op;
    }
  });
}
