import fsp from 'node:fs/promises';
import { agyCostUsd, agyCostUsdByType, agyLongThreshold } from '../pricing.js';
import { AGY_DIR, MIRROR_DIR, allConversations, conversationCwd, syncMirror } from './agy-db.js';
import { billedTokens, collectResponses } from './agy-transcript.js';

// Usage, cost and activity for agy conversations, read from their JSONL mirrors
// (agy-db.js keeps each up to date from agy's own database).

const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// Replies → { [model]: totals } in the shape pricing.js agyCostUsd bills, a reply
// whose prompt crossed its model's long-context threshold also counted under `long`.
export function totalsOf(responses) {
  const totals = {};
  for (const r of responses) {
    const model = r.model || 'gemini-pro';
    const t = (totals[model] ||= blank());
    const b = billedTokens(r.usage);
    t.input += b.input;
    t.output += b.output;
    t.cacheRead += b.cacheRead;
    if (b.prompt > agyLongThreshold(model)) {
      const l = (t.long ||= { input: 0, output: 0, cacheRead: 0 });
      l.input += b.input;
      l.output += b.output;
      l.cacheRead += b.cacheRead;
    }
  }
  return totals;
}

function tokensOf(totals) {
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const t of Object.values(totals)) {
    tokens.input += t.input;
    tokens.output += t.output;
    tokens.cacheRead += t.cacheRead;
  }
  return tokens;
}

async function readLines(file) {
  try { return (await fsp.readFile(file, 'utf8')).split('\n'); } catch { return null; }
}

const NO_TRANSCRIPT = { usd: null, tokens: null, subAgents: [], summary: null, lastActivity: null, contextPercent: null, hasTranscript: false };

// The card enrichment for one conversation: cost, tokens, the model it is on,
// its summary and last activity. agy publishes no context window per model, so
// no context percentage is claimed.
export async function analyzeAgy(sessionId, { since = 0, agyDir = AGY_DIR, mirrorDir = MIRROR_DIR } = {}) {
  const file = syncMirror(sessionId, { agyDir, mirrorDir });
  if (!file) return NO_TRANSCRIPT;
  const lines = await readLines(file);
  if (!lines) return { ...NO_TRANSCRIPT, hasTranscript: true };
  const { responses, summary, lastActivity } = collectResponses(lines, { since });
  const totals = totalsOf(responses);
  const last = responses.reduce((a, r) => (!a || r.ts >= a.ts ? r : a), null);
  return {
    usd: responses.length ? agyCostUsd(totals) : null,
    subAgentUsd: 0,
    costByType: agyCostUsdByType(totals),
    model: last?.model || null,
    currentModel: last?.model || null,
    totals,
    tokens: tokensOf(totals),
    subAgents: [],
    summary: summary ? summary.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    lastActivity,
    contextPercent: null,
    hasTranscript: true,
  };
}

// usage-report.js: one row per conversation, its spend split by the UTC day each
// reply landed on.
export async function scanDaily({ cardId, entry, task, raw, blankTokens, dayKeyOf, maybeYield, usageSince = () => 0 }) {
  const id = entry.liveSessionId || cardId;
  const file = syncMirror(id);
  if (!file) return 0;
  const lines = await readLines(file);
  await maybeYield?.();
  if (!lines) return 1;
  const { responses } = collectResponses(lines, { since: usageSince(entry) || 0 });
  if (!responses.length) return 0;
  const byDay = new Map();
  for (const r of responses) {
    const day = dayKeyOf(r.ts);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const days = {};
  for (const [day, list] of byDay) {
    const totals = totalsOf(list);
    const usd = agyCostUsd(totals);
    const byModel = {};
    for (const [model, t] of Object.entries(totals)) {
      const modelUsd = agyCostUsd({ [model]: t });
      byModel[model] = { usd: modelUsd, estimatedUsd: modelUsd, tokens: { input: t.input, output: t.output, cacheWrite: 0, cacheRead: t.cacheRead } };
    }
    days[day] = {
      provider: 'google',
      usd, estimatedUsd: usd, subAgentUsd: 0, advisorUsd: 0, advisorTokens: blankTokens(),
      tokens: tokensOf(totals),
      byModel,
      costByType: agyCostUsdByType(totals),
    };
  }
  raw.push({ file, cardId, owner: true, task, days });
  return 0;
}

// scripts/cost-report.mjs: this month's replies, one row per conversation.
export async function scanMonth({ cardId, entry, agent, label, sessions, monthStart, monthEnd, taskNameFor, usageSince = () => 0 }) {
  const id = entry.liveSessionId || cardId;
  const file = syncMirror(id);
  if (!file) return 1;
  const lines = await readLines(file);
  if (!lines) return 1;
  const responses = collectResponses(lines, { since: usageSince(entry) || 0 }).responses
    .filter((r) => r.ts >= monthStart && r.ts < monthEnd);
  if (!responses.length) return 0;
  const totals = totalsOf(responses);
  const tok = tokensOf(totals);
  sessions.push({
    cardId, agent, label, task: taskNameFor(cardId),
    totals, usd: agyCostUsd(totals), subAgentUsd: 0,
    tokens: { ...tok, total: tok.input + tok.output + tok.cacheWrite + tok.cacheRead },
    estimated: true, file, owner: true,
  });
  return 0;
}

// get_session_activity: the human's and agy's messages in [startMs, endMs).
export async function activityInRangeAgy(sessionId, startMs, endMs, { agyDir = AGY_DIR, mirrorDir = MIRROR_DIR } = {}) {
  const file = syncMirror(sessionId, { agyDir, mirrorDir });
  if (!file) return null;
  const lines = (await readLines(file)) || [];
  const seen = new Set();
  const tally = { messageCount: 0, firstActivity: null, lastActivity: null };
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || (rec.kind !== 'user' && rec.kind !== 'assistant') || seen.has(rec.idx)) continue;
    if (!String(rec.text || '').trim()) continue;
    const t = Number(rec.ts) || 0;
    if (!t || t < startMs || t >= endMs) continue;
    seen.add(rec.idx);
    tally.messageCount += 1;
    if (tally.firstActivity == null || t < tally.firstActivity) tally.firstActivity = t;
    if (tally.lastActivity == null || t > tally.lastActivity) tally.lastActivity = t;
  }
  return tally;
}

// The adopt picker: recent agy conversations no card owns.
export async function listResumableAgy(excludeIds = new Set(), { windowDays = 7, now = Date.now(), agyDir = AGY_DIR, mirrorDir = MIRROR_DIR } = {}) {
  const cutoff = now - windowDays * 86_400_000;
  const candidates = [];
  for (const { id, mtimeMs } of allConversations(agyDir)) {
    if (mtimeMs < cutoff) break;
    if (excludeIds.has(id)) continue;
    const file = syncMirror(id, { agyDir, mirrorDir });
    const { summary } = collectResponses((file && (await readLines(file))) || []);
    candidates.push({ sessionId: id, cwd: conversationCwd(id, { agyDir }), summary: summary ? summary.slice(0, 200) : null, lastActivity: Math.round(mtimeMs), agent: 'agy' });
  }
  return { candidates, total: candidates.length, windowDays };
}

// The search corpus's sources: every conversation's mirror.
export async function agySources(agyDir = AGY_DIR) {
  const out = [];
  for (const { id } of allConversations(agyDir)) {
    const file = syncMirror(id, { agyDir });
    if (file) out.push({ file, agent: 'agy', id });
  }
  return out;
}
