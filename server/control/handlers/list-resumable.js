import { listResumable } from '../../transcript-reader.js';
import { listResumableCodex } from '../../agents/codex-rollout.js';
import { codex as codexAdapter } from '../../agents/codex.js';

export const listResumableHandler = {
  type: 'list-resumable',
  async handler(msg, ctx) {
    // Find & attach: surface on-disk sessions not already represented in the live
    // board view (now managed-only) or the history view — so a session running
    // outside the wrangler, active or not, is offered here. Scoped to a recency
    // window (default 7 days; the UI can widen to 30).
    const graph = ctx.graph();
    const exclude = new Set((graph?.sessions || []).map((s) => s.sessionId));
    for (const h of graph?.history || []) exclude.add(h.sessionId);
    const windowDays = msg.windowDays === 30 ? 30 : 7;
    const claudeRes = await listResumable(exclude, { windowDays });
    const claudeCands = claudeRes.candidates.map((c) => ({ ...c, agent: 'claude' }));
    let codexCands = [];
    if (await codexAdapter.isAvailable()) {
      const codexRes = await listResumableCodex(exclude, { windowDays });
      codexCands = codexRes.candidates; // already tagged agent: 'codex'
    }
    const candidates = [...claudeCands, ...codexCands].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    ctx.reply({ type: 'resumable', candidates, total: candidates.length, windowDays });
  },
};
