// Wrap a raw issue (a Jira key, a GitHub issue URL/#number, or free-text) into a
// launch prompt that NAMES the issue-to-pr skill. Passing the bare issue prose
// risks the model freelancing and skipping the skill — which loses every
// workflow_phase report and the whole board-tracking arc — so the imperative makes
// the skill the entry point. The raw issue trails verbatim for the skill to parse.
export function workflowLaunchPrompt(rawIssue = '') {
  return 'Use the issue-to-pr skill to take this issue to a PR autonomously, '
    + 'with no human input unless you hit a genuine block. '
    + `Issue: ${String(rawIssue).trim()}`;
}

// A stored `entry.workflow` value is the legacy PRE-MIGRATION worker shape
// (`{parent: <orchestrator card id>}`, nothing else) when it carries a `parent`
// but none of the fields a real orchestrator marker has (issue/phase/startedAt —
// see the child-sessions design). Shared by state-reader.js's read-side
// `deriveParentSession` fallback (board/history nodes) and session-manager.js's
// resume() skill-reload decision, so the two classifications can't drift apart —
// a legacy worker must never be treated as its own orchestrator run in either
// place. A modern worker never sets `entry.workflow` at all (it uses
// `parentSession` instead), so this only ever matches genuinely old entries.
export function isLegacyWorkerWorkflow(workflow) {
  return Boolean(workflow) && workflow.parent != null
    && workflow.issue == null && workflow.phase == null && workflow.startedAt == null;
}
