import { codexCostUsd } from '../pricing.js';

export async function scanDaily({ cardId, entry, task, trackedSessionIds, codexRolloutIndex, codexSessionsDir, seenCodexFiles, analyzeCodexCached, analyzeCodex, findRolloutChain, maybeYield, blankTokens, dayKeyOf, raw }) {
  // Codex rollouts aren't reliably line-stamped for cost, so attribute the whole
  // (estimated, ChatGPT-plan-equivalent) session to its createdAt day — sub-monthly
  // Codex is approximate. A session with no usable createdAt is skipped, not crashed.
  // createdAt is epoch ms (Date.now()); Date.parse would stringify it to NaN and
  // silently drop every Codex session. new Date() takes both that and an ISO string.
  const created = entry.createdAt ? new Date(entry.createdAt).getTime() : NaN;
  if (!Number.isFinite(created)) return;
  const sessionKey = entry.liveSessionId || cardId;
  const rolloutIndex = await codexRolloutIndex();
  const parentId = rolloutIndex.metaById?.get(sessionKey)?.parentId;
  if (parentId && trackedSessionIds.has(parentId)) return;
  const rolloutFile = rolloutIndex.files.get(sessionKey) || null;
  if (rolloutFile) seenCodexFiles.add(rolloutFile);
  const a = rolloutFile
    ? await analyzeCodexCached(analyzeCodex, findRolloutChain, sessionKey, rolloutFile, codexSessionsDir, rolloutIndex)
    : await analyzeCodex(sessionKey, { sessionsDir: codexSessionsDir, index: rolloutIndex }).catch(() => null);
  await maybeYield();
  if (!a || a.usd == null) return;
  const tok = a.tokens || blankTokens();
  const codexTokens = { input: tok.input || 0, output: tok.output || 0, cacheWrite: tok.cacheWrite || 0, cacheRead: tok.cacheRead || 0 };
  const model = a.model || 'gpt-5.5-codex';
  const byModel = {};
  for (const [modelId, modelTotals] of Object.entries(a.totals || { [model]: codexTokens })) {
    const modelTokens = { input: modelTotals.input || 0, output: modelTotals.output || 0, cacheWrite: 0, cacheRead: modelTotals.cacheRead || 0 };
    const modelUsd = codexCostUsd({ [modelId]: modelTotals });
    byModel[modelId] = { usd: modelUsd, estimatedUsd: modelUsd, tokens: modelTokens };
  }
  raw.push({
    file: null, cardId, owner: true, task,
    days: { [dayKeyOf(created)]: {
      provider: 'openai',
      usd: a.usd, estimatedUsd: a.usd, subAgentUsd: a.subAgentUsd || 0, advisorUsd: 0, advisorTokens: blankTokens(),
      tokens: codexTokens,
      // Codex $ is estimated, so its per-model and per-type breakdowns are too.
      byModel,
      costByType: a.costByType || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    } },
  });
  return 0;
}

export async function scanMonth({ cardId, entry, agent, label, sessions, monthStart, monthEnd, codexIndex, trackedSessionIds, analyzeCodex, taskNameFor }) {
  // Codex rollouts aren't line-stamped the same way; attribute the whole
  // session to its createdAt month (estimated ChatGPT-plan pricing).
  // createdAt is epoch ms (Date.now()); Date.parse would stringify it to NaN and
  // silently drop every Codex session. new Date() takes both that and an ISO string.
  const created = entry.createdAt ? new Date(entry.createdAt).getTime() : NaN;
  if (!Number.isFinite(created) || created < monthStart || created >= monthEnd) return 0;
  const sessionKey = entry.liveSessionId || cardId;
  const parentId = codexIndex?.metaById.get(sessionKey)?.parentId;
  if (parentId && trackedSessionIds.has(parentId)) return 0;
  const a = await analyzeCodex(sessionKey, { index: codexIndex }).catch(() => null);
  if (!a || a.usd == null) { return 1; }
  const tok = a.tokens || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  sessions.push({
    cardId, agent, label, task: taskNameFor(cardId),
    totals: a.totals || {}, usd: a.usd,
    subAgentUsd: a.subAgentUsd || 0,
    tokens: { ...tok, total: tok.input + tok.output + tok.cacheWrite + tok.cacheRead },
    estimated: true,
  });
  return 0;
}
