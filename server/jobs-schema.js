import { z } from 'zod';
import path from 'node:path';

export const line = z.string().trim().min(1).max(180).refine((s) => !/[\r\n]/.test(s), 'Use one short line');
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const jira = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
export const jiraProject = z.string().regex(/^[A-Z][A-Z0-9]*$/);
export const prUrlSchema = z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/);
const repoPath = z.string().trim().min(1).max(1000).refine(
  (s) => !/[\r\n\0]/.test(s) && (path.isAbsolute(s) || s.startsWith('~/')),
  'Use an absolute local repository path or ~/path',
);
export const checksSchema = z.array(line).min(1).max(8);
export const briefSchema = z.string().trim().min(1).max(500);
// A sub-job is either a PR to a repository or an agent session on this machine.
// The session kind has no repo: it runs in a scratch workspace and is finished
// when its receipt is accepted, so a dependency on it gates the dependent's
// START (its output is an input), unlike a PR's deploy-after.
//
// Nothing here describes deployment or verification: the runner infers whether a
// merge deploys from the repository's own workflows (job-deploys.js) and watches
// whatever GitHub starts. `check` is the one line a pipeline cannot prove — and
// only on a PR, because a session's receipt IS its check.
//
// A PR sub-job names no branch: the plan cannot know a repository's convention
// as well as the session working inside it, so the worktree starts on a
// placeholder (`job-runtime.js`) and the implementer renames it via
// `name_branch` (`job-store.js` `noteBranchRename` keeps the record in step).
export const subJobSchema = z.object({
  id, title: line, kind: z.enum(['pr', 'session']).default('pr'), repo: repoPath.optional(),
  storyId: id, jiraKey: jira.optional(), after: z.array(id).max(30).default([]),
  brief: briefSchema, check: line.optional(),
});
export const isSessionSub = (sub) => sub?.kind === 'session';
// A story either already exists in Jira (key) or is a proposal (no key, optional
// project hint). Planning never writes to Jira: the human approves the titles and
// their mapping to sub-jobs first, then the ticketing step creates the keyless ones.
export const storySchema = z.object({ id, key: jira.optional(), project: jiraProject.optional(), title: line });
export const storiesKeyed = (plan) => plan.stories.every((s) => s.key);
export const planSchema = z.object({
  // Written once for the whole job, the way a human writes a dispatch: every
  // brief refers to it rather than repeating the background, which is what keeps
  // a brief inside its 500 characters.
  context: z.string().trim().max(2000),
  stories: z.array(storySchema).min(1).max(30),
  subJobs: z.array(subJobSchema).min(1).max(50),
}).superRefine((plan, ctx) => {
  const stories = new Set(plan.stories.map((s) => s.id));
  const nodes = new Map(plan.subJobs.map((s) => [s.id, s]));
  const issue = (message) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (stories.size !== plan.stories.length || nodes.size !== plan.subJobs.length) issue('IDs must be unique');
  for (const s of plan.subJobs) {
    if (isSessionSub(s) && s.repo) issue(`${s.id}: a session sub-job has no repo`);
    if (isSessionSub(s) && s.check) issue(`${s.id}: a session sub-job's receipt is its own check`);
    if (!isSessionSub(s) && !s.repo) issue(`${s.id}: a PR sub-job needs repo`);
  }
  const visiting = new Set(), visited = new Set();
  function visit(s) {
    if (visiting.has(s.id)) { issue('Dependency chains must not contain cycles'); return; }
    if (visited.has(s.id)) return;
    visiting.add(s.id);
    for (const dep of s.after) {
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
  reviewMerge: z.boolean().default(true), reviewSessions: z.boolean().default(true),
  updateMain: z.boolean().default(false), taskId: z.string().nullable().default(null),
});
export const settingsSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(2),
  maxRepairs: z.number().int().min(0).max(5).default(2),
  // How long a merged sub-job may wait for a post-merge workflow to show ANY run
  // on the merge commit before the board flags it (job-runner.js).
  deploymentStaleMinutes: z.number().int().min(5).max(1440).default(30),
  paused: z.boolean().default(false),
});
// A worker never changes the plan: `move` is a SUGGESTION on a blocked receipt,
// which the board offers the human as the pre-selected button (job-moves.js).
export const MOVE_NAMES = ['fix-here', 'split-out', 'new-ticket', 'reorder', 'drop', 'mark'];
// Strict, so a receipt carrying a field this system no longer has (an
// `amendment`, a `commitMessage`) fails loudly with the offending key rather
// than being silently stripped — the agent can then correct and retry, exactly
// as it does for a rejected Jira key.
const receipt = (shape) => z.object(shape).strict();
export const reportSchema = z.discriminatedUnion('kind', [
  receipt({ kind: z.literal('plan'), plan: planSchema }),
  receipt({ kind: z.literal('jira'), stories: z.array(z.object({ id, key: jira })).min(1).max(30) }),
  receipt({ kind: z.literal('published'), url: prUrlSchema }),
  receipt({ kind: z.literal('repaired'), changes: checksSchema, checks: checksSchema }),
  receipt({ kind: z.literal('deployed'), checks: checksSchema }),
  receipt({ kind: z.literal('completed'), checks: checksSchema }),
  receipt({ kind: z.literal('blocked'), summary: line, move: z.enum(MOVE_NAMES).optional() }),
]);
