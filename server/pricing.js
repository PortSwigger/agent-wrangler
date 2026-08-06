// USD per 1M tokens. Prices change over time — update as needed.
// Matched against the model id by substring (fable / opus / sonnet / haiku).
// Cache writes are billed per TTL: 5-minute ephemeral at 1.25x input, 1-hour at
// 2x; cache reads at 0.1x. Claude Code issues both TTLs, so they're priced apart.
const TABLE = [
  { match: 'fable', input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  { match: 'opus', input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  { match: 'sonnet', input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  { match: 'haiku', input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
];

// Unknown/unmapped models price as Opus — the safe high-end default, and lower
// than Fable so we never over-bill an unrecognised model at the top tier.
const DEFAULT = TABLE.find((t) => t.match === 'opus');

function rateFor(model) {
  if (!model) return DEFAULT;
  const m = model.toLowerCase();
  return TABLE.find((t) => m.includes(t.match)) || DEFAULT;
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

// OpenAI / Codex pricing — USD per 1M tokens (developers.openai.com/api/docs/pricing,
// verified 2026-08; gpt-5.6 rates reflect the Jul 30 2026 cut — Terra -20%, Luna -80%).
// Codex usually bills via a ChatGPT plan, so this yields an
// *estimated* API-equivalent cost, not real spend; the UI marks it with `~`.
// Matched by substring, so the more specific row must precede the prefix it
// extends (gpt-5.4-mini before gpt-5.4). Cached input is 10% of input. Unknown
// models fall back to the first (flagship) row.
const OPENAI_TABLE = [
  { match: 'gpt-5.6-sol', input: 5, output: 30, cacheRead: 0.5 },
  { match: 'gpt-5.6-terra', input: 2, output: 12, cacheRead: 0.2 },
  { match: 'gpt-5.6-luna', input: 0.2, output: 1.2, cacheRead: 0.02 },
  { match: 'gpt-5.5', input: 5, output: 30, cacheRead: 0.5 },
  { match: 'gpt-5.4-mini', input: 0.75, output: 4.5, cacheRead: 0.075 },
  { match: 'gpt-5.4', input: 2.5, output: 15, cacheRead: 0.25 },
];
const OPENAI_DEFAULT = OPENAI_TABLE[0];

function openaiRateFor(model) {
  if (!model) return OPENAI_DEFAULT;
  const m = model.toLowerCase();
  return OPENAI_TABLE.find((t) => m.includes(t.match)) || OPENAI_DEFAULT;
}

// totals: { [model]: { input, output, cacheRead } }
export function codexCostUsd(totals) {
  let usd = 0;
  for (const [model, t] of Object.entries(totals)) {
    const r = openaiRateFor(model);
    usd += (t.input * r.input + t.output * r.output + (t.cacheRead || 0) * r.cacheRead) / 1_000_000;
  }
  return usd;
}

// Codex analogue of costUsdByType: the same dollar total split across the token-type
// dimension. Codex never writes cache, so cacheWrite is always 0; the four keys match
// costUsdByType so the two agents share one $-by-type shape. Sums to codexCostUsd.
export function codexCostUsdByType(totals) {
  const out = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const [model, t] of Object.entries(totals)) {
    const r = openaiRateFor(model);
    out.input += (t.input * r.input) / 1_000_000;
    out.output += (t.output * r.output) / 1_000_000;
    out.cacheRead += ((t.cacheRead || 0) * r.cacheRead) / 1_000_000;
  }
  return out;
}
