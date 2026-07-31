// Pure review-session logic, split out of app.js so it can be unit-tested
// without a DOM (see snooze.js). app.js imports these; review.test.js imports
// them directly. Decides the model + intent a "Review session" launch uses.

// The opts a "Review session" launch passes to openDispatch(): the source
// session's exact cwd (a review must share it, no worktree of its own) and its
// agent (so the dialog flips to the complementary one), plus `parentSession` —
// the generic nesting link (see the child-sessions design) so the reviewed
// session's board tile nests the review under it.
export function reviewDispatchOpts(sourceSessionId, s) {
  return { cwd: s.cwd, sourceAgent: s.agent || 'claude', parentSession: sourceSessionId };
}

// The complementary agent's default model value, or null when the source is the
// only installed agent. "Complementary" = the first installed agent whose id
// differs from the source's; its default-marked model (else its first model).
// Two agents exist today (claude, codex); this stays correct if more are added.
export function complementaryModel(sourceAgent, availableAgents) {
  const other = (availableAgents || []).find((a) => a.id !== sourceAgent);
  if (!other || !other.models || !other.models.length) return null;
  return (other.models.find((m) => m.default) || other.models[0]).value;
}

// The seeded review intent — pre-filled into the intent field when a review
// session is launched (only if the field is empty, so it never clobbers text).
export const REVIEW_PROMPT = `You're a review session running in the same working directory as an active development session. Review the current plan and work-in-progress here — read the task memory and the recent changes (\`git status\`, \`git diff\`) — then flag correctness issues, risks, missing cases, and anything that doesn't match the stated intent. Be concrete and cite files/lines. Don't edit code unless I ask.`;
