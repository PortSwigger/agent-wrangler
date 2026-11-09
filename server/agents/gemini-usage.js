import fsp from 'node:fs/promises';
import { geminiCostUsd, geminiCostUsdByType, geminiLongThreshold } from '../pricing.js';
import { GEMINI_TMP, allConversationFiles, cwdForConversation, findConversation, forEachConversationLine, readHeadSync } from './gemini-files.js';
import { billedTokens, collectResponses, geminiText, isSyntheticGeminiUser } from './gemini-transcript.js';

// Every Gemini model the CLI runs today has a 1M-token window (its own
// tokenLimit); Gemma models have 256K.
export function geminiContextWindow(model) {
  if (!model) return null;
  return /^gemma-/.test(model) ? 256_000 : 1_048_576;
}

const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// Responses → { [model]: totals } in the shape pricing.js geminiCostUsd bills,
// with a response whose prompt crossed its model's long-context threshold also
// counted under `long`.
export function totalsOf(responses) {
  const totals = {};
  for (const r of responses) {
    const model = r.model || 'gemini-pro';
    const t = (totals[model] ||= blank());
    const b = billedTokens(r.tokens);
    t.input += b.input;
    t.output += b.output;
    t.cacheRead += b.cacheRead;
    if (b.prompt > geminiLongThreshold(model)) {
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
// how full its context is, its summary and last activity.
export async function analyzeGemini(sessionId, { root = GEMINI_TMP, since = 0 } = {}) {
  const file = await findConversation(sessionId, root);
  if (!file) return NO_TRANSCRIPT;
  const lines = await readLines(file);
  if (!lines) return { ...NO_TRANSCRIPT, hasTranscript: true };
  const { responses, summary, lastActivity } = collectResponses(lines, { since });
  const totals = totalsOf(responses);
  const last = responses.reduce((a, r) => (!a || r.ts >= a.ts ? r : a), null);
  const window = geminiContextWindow(last?.model);
  const contextPercent = last && window ? Math.min(100, Math.round(((Number(last.tokens.input) || 0) / window) * 100)) : null;
  return {
    usd: responses.length ? geminiCostUsd(totals) : null,
    subAgentUsd: 0,
    costByType: geminiCostUsdByType(totals),
    model: last?.model || null,
    currentModel: last?.model || null,
    totals,
    tokens: tokensOf(totals),
    subAgents: [],
    summary: summary ? summary.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    lastActivity,
    contextPercent,
    hasTranscript: true,
  };
}

// usage-report.js: one row per conversation, its spend split by the UTC day
// each response landed on (every response is timestamped, so this is exact).
export async function scanDaily({ cardId, entry, task, raw, blankTokens, dayKeyOf, maybeYield, usageSince = () => 0 }) {
  const id = entry.liveSessionId || cardId;
  const file = await findConversation(id);
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
    const usd = geminiCostUsd(totals);
    const byModel = {};
    for (const [model, t] of Object.entries(totals)) {
      const modelUsd = geminiCostUsd({ [model]: t });
      byModel[model] = { usd: modelUsd, estimatedUsd: modelUsd, tokens: { input: t.input, output: t.output, cacheWrite: 0, cacheRead: t.cacheRead } };
    }
    days[day] = {
      provider: 'google',
      usd, estimatedUsd: usd, subAgentUsd: 0, advisorUsd: 0, advisorTokens: blankTokens(),
      tokens: tokensOf(totals),
      byModel,
      costByType: geminiCostUsdByType(totals),
    };
  }
  raw.push({ file, cardId, owner: readHeadSync(file)?.sessionId === id, task, days });
  return 0;
}

// scripts/cost-report.mjs: this month's responses, one row per conversation.
export async function scanMonth({ cardId, entry, agent, label, sessions, monthStart, monthEnd, taskNameFor, usageSince = () => 0 }) {
  const id = entry.liveSessionId || cardId;
  const file = await findConversation(id);
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
    totals, usd: geminiCostUsd(totals), subAgentUsd: 0,
    tokens: { ...tok, total: tok.input + tok.output + tok.cacheWrite + tok.cacheRead },
    estimated: true, file, owner: true,
  });
  return 0;
}

// get_session_activity: the human's and Gemini's messages in [startMs, endMs).
export async function activityInRangeGemini(sessionId, startMs, endMs, root = GEMINI_TMP) {
  const file = await findConversation(sessionId, root);
  if (!file) return null;
  const seen = new Set();
  const tally = { messageCount: 0, firstActivity: null, lastActivity: null };
  await forEachConversationLine(file, (line) => {
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const list = Array.isArray(rec?.$set?.messages) ? rec.$set.messages : [rec];
    for (const m of list) {
      if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
      if (m.type !== 'gemini' && m.type !== 'user') continue;
      const text = geminiText(m.content).trim();
      if (!text || (m.type === 'user' && isSyntheticGeminiUser(text))) continue;
      const t = Date.parse(m.timestamp);
      if (!t || t < startMs || t >= endMs) continue;
      seen.add(m.id);
      tally.messageCount += 1;
      if (tally.firstActivity == null || t < tally.firstActivity) tally.firstActivity = t;
      if (tally.lastActivity == null || t > tally.lastActivity) tally.lastActivity = t;
    }
  });
  return tally;
}

// The adopt picker: recent Gemini conversations no card owns, from the board's
// own Gemini home only — one started in ~/.gemini cannot be resumed from there.
export async function listResumableGemini(excludeIds = new Set(), { windowDays = 7, now = Date.now(), root = GEMINI_TMP[0] } = {}) {
  const cutoff = now - windowDays * 86_400_000;
  const candidates = [];
  for (const { file, mtimeMs } of await allConversationFiles(root)) {
    if (mtimeMs < cutoff) continue;
    const head = readHeadSync(file);
    if (!head?.sessionId || head.kind === 'subagent' || excludeIds.has(head.sessionId)) continue;
    const lines = await readLines(file);
    const { summary } = collectResponses(lines || []);
    candidates.push({ sessionId: head.sessionId, cwd: cwdForConversation(file), summary: summary ? summary.slice(0, 200) : null, lastActivity: Math.round(mtimeMs), agent: 'gemini' });
  }
  return { candidates, total: candidates.length, windowDays };
}
