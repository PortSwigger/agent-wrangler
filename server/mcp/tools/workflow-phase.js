import { z } from 'zod';

// For an autopilot issue→PR run (the `issue-to-pr` skill): report the phase you're
// in so the board chip tracks progress with no human watching. Keyed on the caller's
// card id, so it stamps the running session's own marker. Mirrors set-links.js shape.
export const workflowPhaseTool = {
  name: 'workflow_phase',
  description:
    'Autopilot only: report the phase your issue→PR run is currently in, so the board '
    + 'chip tracks progress. Call it at each transition. The label must be 6 characters '
    + 'or fewer (it has to fit the chip). Suggested vocabulary: '
    + '"plan" → "build" → "verify" → "PR" → "done" (or "failed" '
    + 'if you give up). The label is freeform text; `kind` tints the chip.',
  inputSchema: {
    label: z.string().min(1).max(6).describe('The current phase, ≤6 chars, e.g. "plan", "build", "verify", "PR", "done", "failed".'),
    kind: z.enum(['neutral', 'active', 'warning', 'success', 'danger']).optional()
      .describe('Chip tint: neutral (idle), active (in progress, default), warning, success (done), danger (failed/blocked).'),
  },
  async handler({ deps, caller }, args = {}) {
    if (caller == null) return errorResult('This request carried no session identity, so the workflow phase cannot be recorded.');
    deps.sessionManager.setWorkflowPhase(caller, { label: args.label, kind: args.kind });
    await deps.rebuild?.();
    const structuredContent = { label: args.label, kind: args.kind ?? null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
