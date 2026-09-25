import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { logWarn } from './log.js';

// API prices, sourced from LiteLLM's community-maintained price list rather than
// hand-copied tables that go stale every time a model ships or is repriced. The
// effective catalog is the bundled snapshot (so a fresh or offline install still
// prices correctly) overlaid with the last good fetch, cached under DATA_DIR.
// Snapshot entries are never dropped by a fetch, so a model upstream later
// delists still prices its historical usage. `npm run gen:catalog` refreshes the
// snapshot.
export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const CACHE_PATH = path.join(DATA_DIR, 'price-catalog.json');
const SNAPSHOT_PATH = new URL('./price-catalog.snapshot.json', import.meta.url);
const REFRESH_MS = 12 * 60 * 60 * 1000;
const PROVIDERS = ['anthropic', 'openai'];
const MODES = new Set(['chat', 'responses']);
// A fetch that reduces to fewer rows than this is a broken or truncated upstream
// file, not a real catalog — keep what we have rather than adopt it.
const MIN_ROWS = 10;

// LiteLLM quotes USD per token; we keep USD per 1M. Rounded so 4e-6 comes out as 4,
// not 3.9999999999999996.
function perM(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x * 1e12) / 1e6 : undefined;
}

// One LiteLLM entry → { input, output, cacheWrite5m, cacheWrite1h, cacheRead, long? }.
// Missing cache rates default to Anthropic's standard multipliers (5m write 1.25x,
// 1h write 2x, read 0.1x). `long` is the rate for a whole request whose prompt
// exceeds `threshold` tokens.
export function reduceEntry(e) {
  const input = perM(e.input_cost_per_token);
  const output = perM(e.output_cost_per_token);
  if (input === undefined || output === undefined) return null;
  const cacheRead = perM(e.cache_read_input_token_cost) ?? input * 0.1;
  const rate = {
    input,
    output,
    cacheWrite5m: perM(e.cache_creation_input_token_cost) ?? input * 1.25,
    cacheWrite1h: perM(e.cache_creation_input_token_cost_above_1hr) ?? input * 2,
    cacheRead,
  };
  for (const key of Object.keys(e)) {
    const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (!m) continue;
    const suffix = `_above_${m[1]}k_tokens`;
    const longInput = perM(e[key]);
    if (longInput === undefined) continue;
    rate.long = {
      threshold: Number(m[1]) * 1000,
      input: longInput,
      output: perM(e[`output_cost_per_token${suffix}`]) ?? output,
      cacheRead: perM(e[`cache_read_input_token_cost${suffix}`]) ?? cacheRead,
    };
  }
  return rate;
}

// LiteLLM's whole file → { anthropic: {id: rate}, openai: {id: rate} }. Only the
// providers' own first-party ids (no "bedrock/…"-style routes) for chat models.
export function reduceLitellm(raw) {
  const out = Object.fromEntries(PROVIDERS.map((p) => [p, {}]));
  for (const [id, e] of Object.entries(raw || {})) {
    if (!e || !PROVIDERS.includes(e.litellm_provider) || !MODES.has(e.mode) || id.includes('/')) continue;
    const rate = reduceEntry(e);
    if (rate) out[e.litellm_provider][id.toLowerCase()] = rate;
  }
  return out;
}

function rowCount(cat) {
  return PROVIDERS.reduce((n, p) => n + Object.keys(cat?.[p] || {}).length, 0);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const snapshot = readJson(SNAPSHOT_PATH) || {};
let fetched = readJson(CACHE_PATH);
let tables = null;
let version = 0;
const memo = new Map();
const listeners = new Set();

function rebuild() {
  tables = Object.fromEntries(PROVIDERS.map((p) => [p, { ...snapshot[p], ...fetched?.[p] }]));
  memo.clear();
  version += 1;
}
rebuild();

// Bumps whenever the effective prices change — fold into any cache of costed $.
export function priceCatalogVersion() {
  return version;
}

export function onPriceCatalogChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Numeric version segments of an id, for "newest" comparisons: claude-opus-5-5 →
// [5,5], gpt-5.6-sol → [5,6], claude-haiku-4-5-20251001 → [4,5] (dates skipped).
function versionOf(id) {
  return id.split(/[-.]/).filter((s) => /^\d{1,2}$/.test(s)).map(Number);
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

// The rate for `model` in one provider's table:
//  1. exact id;
//  2. the longest id that is a prefix of it at a segment boundary — dated ids
//     (…-20251001), suffixes (gpt-5.5-codex, "claude-opus-4-8 (advisor)");
//  3. an unlisted sibling (claude-opus-6, gpt-6-astra before upstream has it)
//     prices as the newest model sharing its family stem (claude-opus, gpt-6),
//     the most expensive of those on a version tie;
//  4. otherwise null, and the caller applies its own default.
function lookup(table, model) {
  const m = String(model || '').toLowerCase().trim();
  if (!m) return null;
  if (table[m]) return table[m];
  let best = null;
  for (const id of Object.keys(table)) {
    if (m.startsWith(id) && !/[a-z0-9]/.test(m[id.length]) && (!best || id.length > best.length)) best = id;
  }
  if (best) return table[best];
  const segments = m.split('-');
  for (let n = segments.length; n >= 2; n -= 1) {
    const stem = `${segments.slice(0, n).join('-')}-`;
    let pick = null;
    for (const id of Object.keys(table)) {
      if (!id.startsWith(stem)) continue;
      const cmp = pick ? compareVersions(versionOf(id), versionOf(pick)) : 1;
      if (cmp > 0 || (cmp === 0 && table[id].input > table[pick].input)) pick = id;
    }
    if (pick) return table[pick];
  }
  return null;
}

export function priceFor(provider, model) {
  const key = `${provider}\0${model}`;
  if (!memo.has(key)) memo.set(key, lookup(tables[provider] || {}, model));
  return memo.get(key);
}

// The newest first-party Claude model of a family, as a display name:
// newestClaudeName('opus') → "Opus 5.5". Null when the catalog has none.
export function newestClaudeName(family) {
  const re = new RegExp(`^claude-${family}-(\\d{1,2})(?:-(\\d{1,2}))?$`);
  let best = null;
  for (const id of Object.keys(tables.anthropic)) {
    const m = re.exec(id);
    if (!m) continue;
    const v = [Number(m[1]), m[2] == null ? -1 : Number(m[2])];
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  if (!best) return null;
  const name = family[0].toUpperCase() + family.slice(1);
  return `${name} ${best[0]}${best[1] >= 0 ? `.${best[1]}` : ''}`;
}

// Fetch LiteLLM's list and adopt it if it reduces to a plausible catalog. Returns
// true when the effective prices changed. Never throws — a failed refresh keeps
// the current catalog.
export async function refreshPriceCatalog({ fetchImpl = globalThis.fetch, url = LITELLM_URL, cachePath = CACHE_PATH } = {}) {
  let reduced;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    reduced = reduceLitellm(await res.json());
  } catch (err) {
    logWarn(`[agent-wrangler] price catalog refresh failed: ${err.message}`);
    return false;
  }
  if (rowCount(reduced) < MIN_ROWS) {
    logWarn(`[agent-wrangler] price catalog refresh ignored: only ${rowCount(reduced)} rows`);
    return false;
  }
  const next = { fetchedAt: new Date().toISOString(), source: url, ...reduced };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, `${JSON.stringify(next)}\n`);
  } catch (err) {
    logWarn(`[agent-wrangler] price catalog cache write failed: ${err.message}`);
  }
  const changed = PROVIDERS.some((p) => JSON.stringify(reduced[p]) !== JSON.stringify(fetched?.[p]));
  fetched = next;
  if (changed) {
    rebuild();
    for (const fn of listeners) fn();
  }
  return changed;
}

// Refresh now if the cached fetch is stale, then on a fixed cadence.
export function startPriceCatalogRefresh() {
  const age = Date.now() - Date.parse(fetched?.fetchedAt || 0);
  if (!(age < REFRESH_MS)) refreshPriceCatalog();
  const t = setInterval(() => refreshPriceCatalog(), REFRESH_MS);
  t.unref?.();
  return t;
}

// Test seam: replace the fetched overlay (null = snapshot only).
export function _setFetchedForTest(cat) {
  fetched = cat;
  rebuild();
}
