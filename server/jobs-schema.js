import { z } from 'zod';
import path from 'node:path';
import { isValidBranchName } from './worktree.js';

const line = z.string().trim().min(1).max(180).refine((s) => !/[\r\n]/.test(s), 'Use one short line');
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const jira = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const jiraProject = z.string().regex(/^[A-Z][A-Z0-9]*$/);
const repoPath = z.string().trim().min(1).max(1000).refine(
  (s) => !/[\r\n\0]/.test(s) && (path.isAbsolute(s) || s.startsWith('~/')),
  'Use an absolute local repository path or ~/path',
);
export const checksSchema = z.array(line).min(1).max(8);
export const deploymentSchema = z.object({
  workflows: z.array(z.string().trim().min(1).max(150)).min(1).max(12),
  verify: z.string().trim().min(1).max(4000),
});
// A sub-job is either a PR to a repository or an agent session on this machine.
// The session kind has no repo and no deployment: it runs in a scratch workspace
// and is finished when its receipt is accepted, so a dependency on it gates the
// dependent's START (its output is an input), unlike a PR's deploy-after.
// The branch a PR sub-job will be published from, in the repository's own
// convention — proposed by planning, reviewed by the human, used verbatim at
// dispatch (`job-runtime.js`). `{key}` stands for the sub-job's Jira key, which a
// story proposed at planning time does not have yet; `resolveBranch` fills it in
// when the plan activates. Validated with the placeholder substituted, so
// `{key}-fix-login` is judged as `AUTH-1-fix-login`.
export const KEY_PLACEHOLDER = '{key}';
export const resolveBranch = (branch, key) => branch.replaceAll(KEY_PLACEHOLDER, key);
const branchName = z.string().trim().min(1).max(120).refine((b) => isValidBranchName(resolveBranch(b, 'AUTH-1')), 'Not a valid git branch name');
export const subJobSchema = z.object({
  id, title: line, kind: z.enum(['pr', 'session']).default('pr'), repo: repoPath.optional(), branch: branchName.optional(),
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
  const branches = new Set();
  for (const s of plan.subJobs) {
    if (isSessionSub(s) && (s.repo || s.deployment || s.branch)) issue(`${s.id}: a session sub-job has no repo, branch or deployment`);
    if (!isSessionSub(s) && (!s.repo || !s.deployment)) issue(`${s.id}: a PR sub-job needs repo and deployment`);
    // Two sub-jobs of one repo on one branch would silently become `name` and
    // `name-2` at dispatch — the human approved neither of those.
    if (s.branch) { const k = `${s.repo}\0${s.branch}`; if (branches.has(k)) issue(`${s.id}: branch ${s.branch} is already used by another sub-job in ${s.repo}`); branches.add(k); }
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
export const jobInputSchema = z.object({
  title: line, intent: z.string().trim().min(1).max(16000),
  repos: z.array(repoPath).max(30).default([]),
  agent: z.enum(['claude', 'codex']).default('claude'), model: z.string().max(150).default(''),
  planningPrompt: z.string().max(8000).default(''),
  reviewCode: z.boolean().default(false), reviewMerge: z.boolean().default(true), reviewSessions: z.boolean().default(true),
  updateMain: z.boolean().default(false), taskId: z.string().nullable().default(null),
});
export const settingsSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(2),
  maxRepairs: z.number().int().min(0).max(5).default(2),
  maxRunMinutes: z.number().int().min(5).max(480).default(120),
  paused: z.boolean().default(false),
});
export const reportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), plan: planSchema }),
  z.object({ kind: z.literal('jira'), stories: z.array(z.object({ id, key: jira })).min(1).max(30) }),
  z.object({ kind: z.literal('local'), commitMessage: line, checks: checksSchema,
    pendingChecks: z.array(line).max(8).optional() }),
  z.object({ kind: z.literal('published'), url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/) }),
  z.object({ kind: z.literal('repaired'), changes: checksSchema, checks: checksSchema }),
  z.object({ kind: z.literal('deployed'), checks: checksSchema }),
  z.object({ kind: z.literal('completed'), checks: checksSchema }),
  z.object({ kind: z.literal('blocked'), summary: line }),
]);
