import { subagentDetail as realDetail } from '../../transcript-reader.js';

// On-demand, uncached read of one sub-agent's transcript for the detail modal. A
// fresh, TARGETED reply to the requesting client only (like get-memory), never
// broadcast — only the clicker needs it. The fetch is a ctx seam for test isolation.
export const subagentDetailHandler = {
  type: 'subagent-detail',
  async handler(msg, ctx) {
    const fetch = ctx.subagentDetail || realDetail;
    // The client sends the CARD id; the transcript (and its subagents/ dir) is named
    // by the CONVERSATION id. Resolve card → liveSessionId off the graph, falling
    // back to the card id for legacy pre-split entries — exactly the id the eager
    // `analyze(entry.liveSessionId || sid)` enrichment uses (state-reader.js).
    const node = ctx.sessionFromGraph?.(msg.sessionId);
    const convId = node?.liveSessionId || msg.sessionId;
    const { prompt, toolCalls, result } = await fetch(convId, msg.subagentId);
    // Echo back the CARD id the client sent (not convId) so it can correlate the
    // reply against the exact modal request it made — subagentId alone is fine in
    // practice (ids are effectively unique per dispatch) but doesn't hold up as a
    // sole key if the client ever opens two modals for the same id across sessions.
    ctx.reply({ type: 'subagent-detail', sessionId: msg.sessionId, subagentId: msg.subagentId, prompt, toolCalls, result });
  },
};
