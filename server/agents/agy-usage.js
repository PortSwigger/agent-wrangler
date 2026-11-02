import { exactPriceFor } from '../price-catalog.js';
import { readAgySteps } from './agy-history.js';
import { readAgySummaries } from './agy-summaries.js';
export function agyVendor(model) {
  if (model?.startsWith('gemini-')) return 'gemini';
  if (model?.startsWith('claude-')) return 'anthropic';
  if (/^(gpt-|o\d)/.test(model || '')) return 'openai';
  return 'unknown';
}
export function agyPrice(model) {
  const normalized = String(model || '').replace(/^(gemini-3\.8-flash|gpt-oss-120b)-(low|medium|high)$/, '$1').replace(/^(claude-opus-4-6)-thinking$/, '$1');
  return exactPriceFor(agyVendor(normalized), normalized);
}
export function agyCostUsd(totals) {
  let usd = 0;
  for (const [model, t] of Object.entries(totals || {})) {
    const price = agyPrice(model);
    if (!price && Object.values(t).some((n) => n > 0)) return null;
    if (price) {
      for (const request of t.requests || [t]) {
        const r = price.long && request.input + request.cacheRead > price.long.threshold ? price.long : price;
        usd += ((request.input || 0) * r.input + (request.output || 0) * r.output + (request.cacheRead || 0) * r.cacheRead) / 1e6;
      }
    }
  }
  return usd;
}
const blank = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
export function agyStepTokens(row) {
  const count = (v) => Number.isFinite(v) && v >= 0 ? v : 0;
  return { input: Math.max(0, count(row.input_tokens) - count(row.cache_read_tokens)), output: count(row.output_tokens), cacheWrite: 0, cacheRead: count(row.cache_read_tokens) };
}
export function agyOwnedIds(entry, options) {
  const ids = new Set([...(entry.priorLiveSessionIds || []), entry.liveSessionId, ...(entry.agyChildIds || [])].filter(Boolean));
  const summaries = readAgySummaries(options);
  for (let i = 0; i < summaries.length; i++) {
    const before = ids.size;
    for (const row of summaries) if (ids.has(row.parent_conversation_id)) ids.add(row.conversation_id);
    if (ids.size === before) break;
  }
  return [...ids];
}
export async function scanDaily({ cardId, entry, task, raw, dayKeyOf }) {
  for (const id of agyOwnedIds(entry)) {
    const days = {};
    for (const row of await readAgySteps(id)) {
      if (row.type !== 'PLANNER_RESPONSE') continue;
      const at = Date.parse(row.created_at); if (!Number.isFinite(at)) continue;
      const day = dayKeyOf(at), model = row.model || row.modelName || row.model_name || 'unknown';
      const tokens = agyStepTokens(row), usd = agyCostUsd({ [model]: tokens });
      const key = `${day}:${agyVendor(model)}`;
      const d = days[key] ||= { day, provider: agyVendor(model), usd: 0, estimatedUsd: 0, unpricedTokens: 0, subAgentUsd: 0, advisorUsd: 0, advisorTokens: blank(), tokens: blank(), byModel: {}, costByType: blank() };
      d.usd += usd || 0; d.estimatedUsd += usd || 0;
      if (usd == null) d.unpricedTokens += Object.values(tokens).reduce((n, v) => n + v, 0);
      const m = d.byModel[model] ||= { usd: 0, estimatedUsd: 0, tokens: blank(), unpriced: usd == null };
      m.usd += usd || 0; m.estimatedUsd += usd || 0;
      const price = agyPrice(model);
      const rate = price?.long && tokens.input + tokens.cacheRead > price.long.threshold ? price.long : price;
      for (const k of Object.keys(tokens)) { d.tokens[k] += tokens[k]; m.tokens[k] += tokens[k]; if (rate) d.costByType[k] += tokens[k] * (rate[k] || 0) / 1e6; }
    }
    for (const d of Object.values(days)) { const day = d.day; delete d.day; raw.push({ file: `agy:${id}:${d.provider}:${day}`, cardId, owner: entry.liveSessionId === id, task, days: { [day]: d } }); }
  }
  return 0;
}
export async function scanMonth({ cardId, entry, agent, label, sessions, monthStart, monthEnd, taskNameFor }) {
  for (const id of agyOwnedIds(entry)) {
    const totals = {}, tokens = blank();
    for (const row of await readAgySteps(id)) {
      const at = Date.parse(row.created_at);
      if (row.type !== 'PLANNER_RESPONSE' || at < monthStart || at >= monthEnd || !Number.isFinite(at)) continue;
      const model = row.model || row.modelName || row.model_name || 'unknown';
      const t = agyStepTokens(row), bag = totals[model] ||= { ...blank(), requests: [] };
      bag.requests.push(t);
      for (const k of Object.keys(t)) { tokens[k] += t[k]; bag[k] += t[k]; }
    }
    if (!Object.keys(totals).length) continue;
    sessions.push({ cardId, agent, label, task: taskNameFor(cardId), file: `agy:${id}`, owner: entry.liveSessionId === id, totals, usd: agyCostUsd(totals), subAgentUsd: 0, tokens: { ...tokens, total: Object.values(tokens).reduce((n, v) => n + v, 0) }, estimated: true });
  }
  return 0;
}
