import path from 'node:path';

// The worktree starts on a placeholder branch (job-runtime.js). The session
// working inside the repository is the one that can read its convention, so
// the rename is its job, through name_branch — never `git branch -m`, which
// would leave Wrangler's record (and the PR observer matching on it) behind.
export const placeholderBranch = (job, sub) => `job-${job.id.slice(-8)}-${sub?.id || 'plan'}`;
const branchNaming = (job, sub) => (!sub?.worktree?.branch || sub.worktree.branch === placeholderBranch(job, sub))
  ? `Your worktree branch${sub?.worktree?.branch ? ` (${sub.worktree.branch})` : ''} is a placeholder. Before pushing, rename it with the name_branch MCP tool (never git branch -m) in THIS repository's own branch-naming convention — read its CLAUDE.md, AGENTS.md or CONTRIBUTING and the names of recently merged PRs; this sub-job's Jira key is ${sub?.jiraKey}. Never reuse an existing branch name, and never main/master.`
  : `Your worktree branch is ${sub.worktree.branch}; keep it.`;

// The receipt is the only thing that advances a job, so every prompt ends with
// the exact call. `move` is a suggestion the human sees as a pre-selected
// button on the card; nothing an agent reports ever changes the plan itself.
const blockedLine = 'Blocked: {kind:"blocked", summary:"one sentence", move?:"fix-here"|"split-out"|"new-ticket"|"reorder"|"drop"|"mark"}.';
const lines = (...parts) => parts.filter(Boolean).join('\n');
const afterLine = (job, sub) => `After: ${(sub?.after || []).map((id) => (job.subJobs || []).find((s) => s.id === id)?.title || id).join(' · ') || 'none'}.`;
const contextLine = (job) => job.plan?.context ? `Context: ${job.plan.context}` : '';
const heading = (job, sub) => `${sub?.jiraKey ? `${sub.jiraKey} · ` : ''}${job.title}`;
const noteLine = (sub) => sub?.note ? `Note from the human: ${sub.note}` : '';
const passingWorkflows = (sub) => (sub?.deploymentResult?.runs || []).filter((r) => r.status === 'passing').map((r) => r.workflow).join(', ');

export function jobPrompt(job, sub, run) {
  const report = (body, lead = '') => `${lead}job_report {runId:"${run.id}", ${body}}. ${blockedLine}`;
  const prompts = {
    planning: lines(
      `Plan this job: ${job.title}`,
      '',
      `Goal: ${job.intent}`,
      `Repository hints (optional; discover others as needed): ${JSON.stringify(job.repos || [])}`,
      `Planning guidance: ${job.planningPrompt || 'Prefer the smallest useful independently deployable change.'}`,
      '',
      'Split the goal into Jira stories and the sub-jobs that deliver them. A "pr" sub-job is one repository, one PR, one session: it works, commits, pushes and opens the PR. A "session" sub-job is work on this machine that is not a repository change (a one-off script or migration run, a console change, a spike whose findings later PRs need): no repo, a scratch workspace, a short receipt. Prefer a PR for anything that changes a repository.',
      'Search Jira READ-ONLY with your own tools and authenticated setup — do not infer Jira is unavailable because no Jira tool is listed. Reference an existing story by its real key; propose a new one with no key and, where you can tell, its project (the key prefix). Never invent keys or print credentials, and create, edit or transition NOTHING: the human approves the titles first and a separate step creates them.',
      'Discover the repositories yourself: task memory, Jira references and local checkouts. Reuse a matching checkout; if one is missing, verify the GitHub owner and origin and clone it into ~/IdeaProjects/<repository-name> — never into this workspace, never over an existing directory. Leave every checkout unchanged (no reset, clean or branch switch). Report the verified absolute path so implementation can cut its own worktree beside it.',
      'Write `context` ONCE for the whole job (≤2000 chars), the way a human writes a dispatch: the shared background, conventions and constraints every worker needs. Write each `brief` like a dispatch intent (≤500 chars) that refers to the context rather than repeating it.',
      'Never describe deployments or verification steps: Wrangler reads the repository\'s own workflows to decide whether a merge deploys, and watches whatever GitHub starts. Give `check` (one line) ONLY when the pipeline cannot prove the change works where it lands, e.g. "helm list shows auth-staff-dashboard in dev and prod". A session sub-job has no check — its receipt is its check.',
      '`after` on a PR means DEPLOY AFTER; `after` on a session means START AFTER (its output is an input). Minimise both dependencies and PRs while keeping each piece independently deliverable. Do not propose branch names: the implementing session names its own.',
      job.plan || job.previousPlan || job.feedback ? `Previous plan / feedback: ${JSON.stringify({ plan: job.plan || job.previousPlan, feedback: job.feedback })}` : '',
      '',
      report('kind:"plan", plan:{context, stories:[{id,key?,project?,title}], subJobs:[{id,title,kind:"pr"|"session",repo,storyId,jiraKey?,after:[],brief,check?}]}'),
    ),
    jira: lines(
      `Create the approved Jira stories for: ${job.title}`,
      '',
      'The human approved these titles and how each maps to a sub-job. Make exactly those changes and nothing else. For every story WITHOUT a key, create one story with the approved title as its summary (its description is that title, or nothing), in the story\'s project if given, otherwise the project of the plan\'s existing stories or your Jira setup. Search first so a retry never duplicates one; reuse an existing identical story\'s key. Do not reword approved titles, and do not touch any other ticket. Query Jira with your own tools and authenticated setup; never invent keys or print credentials.',
      `Approved stories: ${JSON.stringify(job.plan?.stories || [])}`,
      '',
      report('kind:"jira", stories:[{id,key}]'),
    ),
    implementation: lines(
      heading(job, sub),
      '',
      contextLine(job),
      '',
      `This PR (${sub?.repo ? path.basename(sub.repo) : 'this repository'}): ${sub?.brief}`,
      sub?.check ? `Check after it lands: ${sub.check}` : '',
      afterLine(job, sub),
      noteLine(sub),
      branchNaming(job, sub),
      '',
      report('kind:"published", url:"<PR url>"', 'Commit, push, open the PR, then '),
    ),
    repair: lines(
      heading(job, sub),
      '',
      `Fix PR ${sub?.pr?.url} on this worktree branch: ${sub?.fixRequested ? `the human asks: ${sub.fixRequested.note || 'take another pass at it'}` : 'failing checks, merge conflicts or requested changes'}.`,
      contextLine(job),
      '',
      'Read the failed logs and review comments, fix the cause, rerun what is relevant, commit and push. Never weaken checks; never merge.',
      '',
      report('kind:"repaired", changes:["what changed"], checks:["what you verified"]'),
    ),
    verify: lines(
      heading(job, sub),
      '',
      `PR ${sub?.pr?.url} merged as ${sub?.pr?.mergeCommit}; post-merge runs passed${passingWorkflows(sub) ? ` (${passingWorkflows(sub)})` : ''}.`,
      `Confirm: ${sub?.check}`,
      '',
      'Read-only against production; use a playground or dev where behaviour must be exercised, and confirm that environment runs the merged version. Do not change the deployment. Never modify production data — report blocked instead.',
      '',
      report('kind:"deployed", checks:["what you confirmed"]'),
    ),
    session: lines(
      heading(job, sub),
      '',
      contextLine(job),
      '',
      `This session: ${sub?.brief}`,
      afterLine(job, sub),
      noteLine(sub),
      sub?.feedback ? `Feedback on your previous attempt: ${sub.feedback}` : '',
      '',
      'Do it on this machine in this scratch workspace; no repository changes (report blocked if one is needed); checkouts under ~/IdeaProjects are read-only reference. Never modify production data. Record findings later work needs in task memory.',
      '',
      report('kind:"completed", checks:["what you did and how you know"]'),
    ),
  };
  // A version-1 `publish` run still live across the upgrade wants exactly what
  // implementation now says: commit, push, open the PR, report the url.
  return prompts[run.phase] || prompts.implementation;
}
