import { priceFor } from './price-catalog.js';
import { defaultCodexModel } from './agents/codex-catalog.js';

// USD per 1M tokens, from the live price catalog (price-catalog.js) — never
// hand-copied here. Cache writes are billed per TTL (Claude Code issues both).
// A model the catalog can't place prices as the newest Opus — the safe high-end
// default, below Fable so an unrecognised model is never billed at the top tier.
const UNPRICED = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

// A bare Claude Code alias ("fable", "sonnet[1m]") prices as its family's newest model.
function rateFor(model) {
  const alias = /^[a-z]+(?:\[\w+\])?$/.test(model || '') ? `claude-${model.replace(/\[.*$/, '')}` : null;
  return priceFor('anthropic', model) || (alias && priceFor('anthropic', alias)) || priceFor('anthropic', 'claude-opus') || UNPRICED;
}

// totals: { [model]: { input, output, cacheWrite5m, cacheWrite1h, cacheRead } }
export function costUsd(totals) {
  let usd = 0;
  for (const [model, t] of Object.entries(totals)) {
    const r = rateFor(model);
    usd +=
      (t.input * r.input +
        t.output * r.output +
        t.cacheWrite5m * r.cacheWrite5m +
        t.cacheWrite1h * r.cacheWrite1h +
        t.cacheRead * r.cacheRead) /
      1_000_000;
  }
  return usd;
}

// Same inputs as costUsd, but splits the dollar cost by token type (both
// cache-write TTLs collapsed into one cacheWrite figure). Sums to costUsd.
export function costUsdByType(totals) {
  const out = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const [model, t] of Object.entries(totals)) {
    const r = rateFor(model);
    out.input += (t.input * r.input) / 1_000_000;
    out.output += (t.output * r.output) / 1_000_000;
    out.cacheWrite += (t.cacheWrite5m * r.cacheWrite5m + t.cacheWrite1h * r.cacheWrite1h) / 1_000_000;
    out.cacheRead += (t.cacheRead * r.cacheRead) / 1_000_000;
  }
  return out;
}

// OpenAI / Codex pricing, from the same catalog (Standard tier). Codex usually
// bills via a ChatGPT plan, so this yields an *estimated* API-equivalent cost, not
// real spend; the UI marks it with `~`. Unknown models price as Codex's default.
// `long` is the long-context rate, billed for a whole request once its prompt
// exceeds LONG_CONTEXT_TOKENS (every OpenAI long tier today); a model without
// one bills every request at the short rate.
export const LONG_CONTEXT_TOKENS = 272_000;

function openaiRateFor(model) {
  return priceFor('openai', model) || priceFor('openai', defaultCodexModel()) || UNPRICED;
}

// Cost of one model's tokens split by type. `t.long` is the share of t's tokens
// that came from long-context requests (a subset, not an addition).
function codexModelCost(model, t) {
  const r = openaiRateFor(model);
  const l = t.long || {};
  const lr = r.long || r;
  const part = (k) => (((t[k] || 0) - (l[k] || 0)) * r[k] + (l[k] || 0) * lr[k]) / 1_000_000;
  return { input: part('input'), output: part('output'), cacheRead: part('cacheRead') };
}

// totals: { [model]: { input, output, cacheRead, long?: { input, output, cacheRead } } }
export function codexCostUsd(totals) {
  let usd = 0;
  for (const [model, t] of Object.entries(totals)) {
    const c = codexModelCost(model, t);
    usd += c.input + c.output + c.cacheRead;
  }
  return usd;
}

// Codex analogue of costUsdByType: the same dollar total split across the token-type
// dimension. Codex never writes cache, so cacheWrite is always 0; the four keys match
// costUsdByType so the two agents share one $-by-type shape. Sums to codexCostUsd.
export function codexCostUsdByType(totals) {
  const out = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const [model, t] of Object.entries(totals)) {
    const c = codexModelCost(model, t);
    out.input += c.input;
    out.output += c.output;
    out.cacheRead += c.cacheRead;
  }
  return out;
}
