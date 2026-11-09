// A card's headless runs by another agent (session-manager
// recordPriorLiveSessionId keeps them in `entry.billedRuns`), each as the entry
// shape that agent's usage scanner reads: the run's own conversation, dated when
// it was billed. A card's own transcripts are priced by its own agent's
// scanner, so a Codex review of a Claude card is priced by Codex's, and the
// row it yields carries the card's id like any other.
export function billedRunEntries(entry) {
  return (Array.isArray(entry?.billedRuns) ? entry.billedRuns : [])
    .filter((r) => r && typeof r.agent === 'string' && typeof r.liveSessionId === 'string' && r.liveSessionId)
    .map((r) => ({ agent: r.agent, entry: { agent: r.agent, liveSessionId: r.liveSessionId, createdAt: r.at } }));
}
