// Self-lookup of spend: the caller's cost exactly as its board card shows it, read
// off the same graph row (deps.graph(), rebuilt every ~4s) rather than re-costing
// the transcript here — two computations would drift, and the card is the number
// the human sees. That also fixes the scope: the CURRENT conversation (a fork
// excludes the parent's replayed history; a /clear starts a new transcript), not
// every transcript the card has ever owned.
export const getSessionCostTool = {
  name: 'get_session_cost',
  description:
    'Get YOUR OWN spend so far, in USD — the same figure your Agent Wrangler board card shows. '
    + 'Covers your current conversation, sub-agents included (a fork excludes the history it '
    + 'inherited; a /clear starts a fresh count). `usd` is the total; `subAgentUsd` and `advisorUsd` '
    + 'are "of which" breakouts, not additions. `estimated: true` means the figure is priced from '
    + 'token counts the agent reports rather than exact billing (Codex). `usd` is null when no '
    + 'transcript has been costed yet. Refreshed every few seconds, so it may trail your latest '
    + 'turn slightly. Read-only.',
  inputSchema: {},
  async handler({ deps, caller }) {
    if (!caller) return errorResult('No caller identity on this request — this tool answers for the calling session only.');
    const row = deps.graph?.()?.sessions?.find((s) => s.sessionId === caller);
    if (!row) return errorResult('Caller session not found on the board.');

    const subAgentUsd = (row.subAgents || []).reduce((sum, a) => sum + (typeof a.usd === 'number' ? a.usd : 0), 0);
    const structuredContent = {
      sessionId: caller,
      usd: row.usd ?? null,
      estimated: row.agent === 'codex',
      subAgentUsd,
      advisorUsd: row.advisorUsd ?? 0,
      tokens: row.tokens ?? null,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
};

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
