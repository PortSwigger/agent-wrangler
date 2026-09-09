import { z } from 'zod';
import path from 'node:path';

export const line = z.string().trim().min(1).max(180).refine((s) => !/[\r\n]/.test(s), 'Use one short line');
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const jira = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const jiraProject = z.string().regex(/^[A-Z][A-Z0-9]*$/);
const repoPath = z.string().trim().min(1).max(1000).refine(
  (s) => !/[\r\n\0]/.test(s) && (path.isAbsolute(s) || s.startsWith('~/')),
  'Use an absolute local repository path or ~/path',
);
export const checksSchema = z.array(line).min(1).max(8);
// Presence alone means "something deploys from this repo when a PR merges" —
// deliberately NOT a list of workflow names. The observer discovers the runs
// GitHub actually started for the merge commit (`job-github.js` deployment()),
// so the plan only has to carry the one bit a human should review (does this
// merge deploy at all) plus how to check the deployed service afterwards.
export const deploymentSchema = z.object({
  verify: z.string().trim().min(1).max(4000),
});
// A sub-job is either a PR to a repository or an agent session on this machine.
// The session kind has no repo and no deployment: it runs in a scratch workspace
// and is finished when its receipt is accepted, so a dependency on it gates the
// dependent's START (its output is an input), unlike a PR's deploy-after.
// A PR sub-job names no branch: the plan cannot know a repository's convention
// as well as the session working inside it, so the worktree starts on a
// placeholder (`job-runtime.js`) and the implementer renames it via
// `name_branch` (`job-store.js` `noteBranchRename` keeps the record in step).
export const subJobSchema = z.object({
  id, title: line, kind: z.enum(['pr', 'session']).default('pr'), repo: repoPath.optional(),
  storyId: id, jiraKey: jira.optional(), dependsOn: z.array(id).max(30).default([]),
  instructions: z.string().trim().min(1).max(8000), deployment: deploymentSchema.optional(),
});
export const isSessionSub = (sub) => sub?.kind === 'session';
// A story either already exists in Jira (key) or is a proposal (no key, optional
// project hint). Planning never writes to Jira: the human approves the titles and
// their mapping to sub-jobs first, then the ticketing step creates the keyless ones.
export const storySchema = z.object({ id, key: jira.optional(), project: jiraProject.optional(), title: line, value: line });
export const storiesKeyed = (plan) => plan.stories.every((s) => s.key);
export const planSchema = z.object({
  stories: z.array(storySchema).min(1).max(30),
  subJobs: z.array(subJobSchema).min(1).max(50),
}).superRefine((plan, ctx) => {
  const stories = new Set(plan.stories.map((s) => s.id));
  const nodes = new Map(plan.subJobs.map((s) => [s.id, s]));
  const issue = (message) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (stories.size !== plan.stories.length || nodes.size !== plan.subJobs.length) issue('IDs must be unique');
  for (const s of plan.subJobs) {
    if (isSessionSub(s) && (s.repo || s.deployment)) issue(`${s.id}: a session sub-job has no repo or deployment`);
    // A PR without `deployment` is one whose delivery IS the merge (docs, CI or
    // agent-instruction files, a client library): nothing deploys on push, so
    // the runner marks it deployed when GitHub reports the merge and never waits
    // for a workflow run that cannot exist.
    if (!isSessionSub(s) && !s.repo) issue(`${s.id}: a PR sub-job needs repo`);
  }
  const visiting = new Set(), visited = new Set();
  function visit(s) {
    if (visiting.has(s.id)) { issue('Dependency chains must not contain cycles'); return; }
    if (visited.has(s.id)) return;
    visiting.add(s.id);
    for (const dep of s.dependsOn) {
      if (!nodes.has(dep)) issue(`Unknown dependency: ${dep}`);
      else visit(nodes.get(dep));
    }
    visiting.delete(s.id); visited.add(s.id);
  }
  for (const s of plan.subJobs) {
    if (!stories.has(s.storyId)) issue(`Unknown story: ${s.storyId}`);
    visit(s);
  }
});
export const AMENDMENT_AUTHORITIES = ['review', 'auto-tighten', 'auto'];
export const jobInputSchema = z.object({
  title: line, intent: z.string().trim().min(1).max(16000),
  repos: z.array(repoPath).max(30).default([]),
  agent: z.enum(['claude', 'codex']).default('claude'), model: z.string().max(150).default(''),
  planningPrompt: z.string().max(8000).default(''),
  reviewCode: z.boolean().default(false), reviewMerge: z.boolean().default(true), reviewSessions: z.boolean().default(true),
  // Who may change an approved plan without a human: nobody ('review'), an agent
  // whose every op only adds a constraint ('auto-tighten'), or any agent ('auto').
  amendmentAuthority: z.enum(AMENDMENT_AUTHORITIES).default('review'),
  updateMain: z.boolean().default(false), taskId: z.string().nullable().default(null),
});
export const settingsSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(2),
  maxRepairs: z.number().int().min(0).max(5).default(2),
  maxRunMinutes: z.number().int().min(5).max(480).default(120),
  // How long a merged sub-job may wait for a named deployment workflow to show
  // ANY run on the merge commit before the board flags it (job-runner.js).
  deploymentStaleMinutes: z.number().int().min(5).max(1440).default(30),
  paused: z.boolean().default(false),
});
// An amendment is a typed, reviewable change to the approved plan (job-amendments.js
// validates it against the live job). The ops are deliberately a closed set over
// the plan's mutable facts: a sub-job's repo, kind, story and — once a worktree
// exists — branch are frozen, because receipts, PRs and the ticket already refer to
// them; a wrong one is cancelled and re-added, never edited. Nothing here can
// touch the ledger (receipts, heads, merges, deployed markers).
export const amendmentOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add-sub-job'), spec: subJobSchema }),
  z.object({ op: z.literal('add-dependency'), subJobId: id, dependsOn: id }),
  z.object({ op: z.literal('remove-dependency'), subJobId: id, dependsOn: id }),
  z.object({ op: z.literal('set-deployment'), subJobId: id, deployment: deploymentSchema.nullable() }),
  z.object({ op: z.literal('set-pending-checks'), subJobId: id, pendingChecks: z.array(line).max(8) }),
  z.object({ op: z.literal('set-instructions'), subJobId: id, instructions: z.string().trim().min(1).max(8000) }),
  z.object({ op: z.literal('set-recovered-by'), subJobId: id, fixSubJobId: id }),
]);
export const amendmentSchema = z.object({ reason: line, ops: z.array(amendmentOpSchema).min(1).max(20) });
// Every receipt may carry one amendment: a blocked receipt with an amendment is
// the human's one-click fix, and a successful one can still correct the plan for
// the sub-jobs that follow.
const withAmendment = (variants) => variants.map((v) => v.extend({ amendment: amendmentSchema.optional() }));
export const reportSchema = z.discriminatedUnion('kind', withAmendment([
  z.object({ kind: z.literal('plan'), plan: planSchema }),
  z.object({ kind: z.literal('jira'), stories: z.array(z.object({ id, key: jira })).min(1).max(30) }),
  z.object({ kind: z.literal('local'), commitMessage: line, checks: checksSchema,
    pendingChecks: z.array(line).max(8).optional() }),
  z.object({ kind: z.literal('published'), url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/) }),
  z.object({ kind: z.literal('repaired'), changes: checksSchema, checks: checksSchema }),
  z.object({ kind: z.literal('deployed'), checks: checksSchema }),
  z.object({ kind: z.literal('completed'), checks: checksSchema }),
  z.object({ kind: z.literal('blocked'), summary: line }),
]));
