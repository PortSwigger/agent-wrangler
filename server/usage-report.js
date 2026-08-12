// Time-bucketed spend/usage aggregation for the Usage dashboard. Recomputes from
// the on-disk Claude/Codex transcripts (never the board's cached per-session
// aggregates), attributing every transcript line to a UTC calendar day by its own
// timestamp, then rolling those days up to the requested granularity (day / week /
// month). This generalises scripts/cost-report.mjs's single-month gate to arbitrary
// calendar buckets; the CLI keeps its own per-model / per-session breakdown, so it is
// intentionally not folded into this leaner (per-task, per-bucket) engine.
//
// The subtle counting is deliberately mirrored from transcript-reader.js /
// cost-report.mjs (CLAUDE.md: the report duplicates the board's logic on purpose so
// they agree): per-message.id dedup for multi-block turns, background sub-agents
// costed from their own subagents/*.jsonl (the inline toolUseResult.usage is a
// last-resort lower bound only), and per-transcript dedup so a resume that re-points
// a fresh card id at an existing conversation is counted once. Getting these wrong
// mis-counts 2–25x, so the copy stays faithful rather than re-derived.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { costUsd, costUsdByType } from './pricing.js';
import { CLAUDE_DIR } from './claude-paths.js';
import { usageSince } from './transcript-reader.js';
import { DATA_DIR as DEFAULT_DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';

const HOME = os.homedir();
const DEFAULT_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const DEFAULT_CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');

export const GRANULARITIES = ['day', 'week', 'month'];
// How many buckets each granularity's default window spans, counting back from the
// current period. Deliberately small: a bare-day view of years of history is
// unreadable, and the client re-requests when the toggle changes.
const WINDOW_BUCKETS = { day: 30, week: 12, month: 12 };

// ---- UTC bucket math (all periods are UTC, like cost-report.mjs) ----------
const DAY_MS = 86_400_000;
const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
// The per-file cache buckets raw totals per UTC HOUR, not per day. It has to: the cache
// outlives its transcript (resolveClaudeTranscript), so whatever resolution it keeps is
// the finest ANY view can ever be recreated at once Claude Code deletes the source — a
// day bucket would make an hourly breakdown of deleted history permanently impossible.
// Aggregating up is free and lossless (`2026-07-10T14` → day by dayOfKey), which is also
// why a legacy day-keyed cache entry needs no migration: its key is already its own day.
const hourKeyOf = (ms) => new Date(ms).toISOString().slice(0, 13);
const dayOfKey = (key) => key.slice(0, 10);

function weekStartMs(ms) {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7; // days since Monday (getUTCDay: Sun=0)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}
function monthStartMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// Start ms of the period CONTAINING ms, for a granularity.
function periodStartMs(ms, granularity) {
  if (granularity === 'week') return weekStartMs(ms);
  if (granularity === 'month') return monthStartMs(ms);
  return Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());
}
// Start ms of the period AFTER the one starting at startMs.
function nextPeriodMs(startMs, granularity) {
  const d = new Date(startMs);
  if (granularity === 'week') return startMs + 7 * DAY_MS;
  if (granularity === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return startMs + DAY_MS;
}
// A day (identified by its dayKey ms) belongs to the period whose key is:
function periodKeyOf(ms, granularity) {
  if (granularity === 'month') return dayKeyOf(monthStartMs(ms)).slice(0, 7);
  if (granularity === 'week') return dayKeyOf(weekStartMs(ms));
  return dayKeyOf(ms);
}

// Enumerate the [start, end) window and its ordered buckets for a granularity,
// ending with the current period. `now` is injectable for deterministic tests.
function windowFor(granularity, now) {
  const count = WINDOW_BUCKETS[granularity] || WINDOW_BUCKETS.day;
  const end = nextPeriodMs(periodStartMs(now, granularity), granularity); // exclusive: end of current period
  let start = periodStartMs(now, granularity);
  for (let i = 1; i < count; i += 1) {
    // Step back one period from `start`. day/week are fixed-width; month varies.
    start = granularity === 'month'
      ? monthStartMs(start - 1)
      : start - (granularity === 'week' ? 7 * DAY_MS : DAY_MS);
  }
  const buckets = [];
  for (let s = start; s < end; s = nextPeriodMs(s, granularity)) {
    buckets.push({ key: periodKeyOf(s, granularity), start: s, end: nextPeriodMs(s, granularity) });
  }
  return { start, end, buckets };
}

// ---- usage accumulation (mirrors transcript-reader.js addUsage) -----------
function addUsage(totals, model, usage) {
  if (!usage) return;
  const key = model || 'unknown';
  const t = (totals[key] ||= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  t.input += usage.input_tokens || 0;
  t.output += usage.output_tokens || 0;
  const cc = usage.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    t.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
    t.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
  } else {
    t.cacheWrite5m += usage.cache_creation_input_tokens || 0;
  }
  t.cacheRead += usage.cache_read_input_tokens || 0;
}
function mergeInto(dest, src) {
  for (const [model, t] of Object.entries(src)) {
    const d = (dest[model] ||= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
    d.input += t.input; d.output += t.output;
    d.cacheWrite5m += t.cacheWrite5m; d.cacheWrite1h += t.cacheWrite1h; d.cacheRead += t.cacheRead;
  }
}

// Mirrors transcript-reader.js addUsageSplit: a turn's real API calls live in
// usage.iterations[], each classified "message" or "advisor_message" (the native
// advisor tool, its own `model`, never cached). Top-level usage fields do NOT
// reliably equal the sum of the "message" iterations once `iterations` exists — real
// turns have been found where the top level under-reports ordinary "message" tokens
// too (not just the advisor's), whenever an "advisor_message" iteration is bundled
// into the same turn — so iterations[] must be walked for correctness generally, not
// only to recover advisor spend. Advisor tokens land in `totals` too, bucketed under
// `${model} (advisor)` rather than the bare model id — even when the advisor happens
// to be the same model the parent turn used, its spend must stay a visibly separate
// row in the Model dimension (byModelOf), not silently merged into ordinary usage.
// pricing.js's substring match still resolves the suffixed key to the right rate.
// advisorTotals is an "of which" breakout for the separate cost line, not an
// addition on top of `totals`.
function addUsageSplit(totals, advisorTotals, model, usage) {
  if (!usage) return;
  const iterations = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : null;
  if (!iterations) {
    addUsage(totals, model, usage);
    return;
  }
  for (const iter of iterations) {
    const isAdvisor = iter?.type === 'advisor_message';
    const key = isAdvisor ? `${iter.model || 'unknown'} (advisor)` : model;
    addUsage(totals, key, iter);
    if (isAdvisor) addUsage(advisorTotals, key, iter);
  }
}
function tokensOf(totals) {
  let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
  for (const t of Object.values(totals)) {
    input += t.input; output += t.output;
    cacheWrite += t.cacheWrite5m + t.cacheWrite1h; cacheRead += t.cacheRead;
  }
  return { input, output, cacheWrite, cacheRead };
}
const blankTokens = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
function addTokens(dest, src) {
  dest.input += src.input; dest.output += src.output;
  dest.cacheWrite += src.cacheWrite; dest.cacheRead += src.cacheRead;
}

// The four token-type segments, in stack/legend order. This is the "Token type" slice
// dimension: fixed (never folded into "Other"), shared by both the $ and Tokens metrics
// (cache lives here now, split write vs read — it is never a standalone metric).
const TYPES = ['input', 'output', 'cacheWrite', 'cacheRead'];
const TYPE_LABELS = { input: 'Input', output: 'Output', cacheWrite: 'Cache write', cacheRead: 'Cache read' };

// A user-facing model label from a raw model id: drop the trailing date/build stamp
// (…-20250514) and the redundant claude- prefix so the legend reads "opus-4" / "sonnet-4"
// / "gpt-5.5-codex". The BUCKET stays keyed by the full id (distinct pricing/versions
// never silently merge); only the display name is shortened.
function modelLabel(id) {
  if (!id) return 'unknown';
  return id.replace(/-\d{6,}$/, '').replace(/^claude-/, '');
}

// Two distinct model ids that differ only by snapshot date clean to the same short
// label (both "opus-4"). Buckets stay keyed by the full id, but the legend renders the
// display NAME — so two identical names would be indistinguishable chips. Where a name
// is shared, append the id's distinguishing stamp (the stripped date, else the full id)
// so each display name is unique while the filterable data keys are left untouched.
function disambiguateNames(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.name, (counts.get(m.name) || 0) + 1);
  return members.map((m) => {
    if (counts.get(m.name) < 2) return m;
    const stamp = /-(\d{6,})$/.exec(m.key);
    return { ...m, name: `${m.name} (${stamp ? stamp[1] : m.key})` };
  });
}

// Per-model {usd, estimatedUsd, tokens} for one day's per-model raw totals, so the
// Model slice reuses the SAME totals the $ costing already walks (never a second count).
// Claude spend is exact (estimatedUsd 0); Codex builds its own estimated byModel inline.
function byModelOf(totals) {
  const out = {};
  for (const [model, t] of Object.entries(totals)) {
    const one = { [model]: t };
    out[model] = { usd: costUsd(one), estimatedUsd: 0, tokens: tokensOf(one) };
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Stream a JSONL transcript line-by-line, invoking onEntry for each parsed object.
// This runs inside the LIVE board's single event loop (unlike cost-report.mjs's
// one-shot CLI), so it must never (a) hold the whole file as one string —
// readFile('utf8') OOMs on a big transcript and outright THROWS past V8's ~536MB
// string cap, which upstream swallowed into a silent $0 undercount — nor (b) parse
// millions of lines in one uninterrupted CPU burst that freezes every /pty and the
// rebuild loop. So: chunked stream + a setImmediate yield every YIELD_EVERY lines.
// A read/stream error propagates (rejects) so the caller can mark the file failed
// rather than silently drop the session. Blank lines and per-line JSON errors are
// skipped, exactly as the prior for…split loop did.
const YIELD_EVERY = 2000;
async function forEachJsonLine(file, onEntry) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (line.trim()) {
        let e; try { e = JSON.parse(line); } catch { e = undefined; }
        if (e !== undefined) onEntry(e);
      }
      if ((n += 1) % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    }
  } finally {
    rl.close();
  }
}

// ---- Claude transcript scan (hour-bucketed) -------------------------------
// Sum every agent-*.jsonl under a session's subagents/ dir into per-hour per-model
// totals (modern async sub-agents own their transcript), with per-file message.id
// dedup — the hour-bucketed mirror of cost-report.mjs backgroundSubTotals. `any`
// marks that background transcripts EXIST (so they, not the parent's inline
// aggregate, are the cost source — analyze()'s precedence).
async function backgroundSubDaily(subDir) {
  let files;
  try { files = await fsp.readdir(subDir); } catch { return { any: false, daily: {}, advisorDaily: {}, failed: false }; }
  const agentFiles = files.filter((f) => /^agent-.+\.jsonl$/.test(f));
  if (!agentFiles.length) return { any: false, daily: {}, advisorDaily: {}, failed: false };
  const daily = {};
  const advisorDaily = {};
  let failed = false;
  for (const f of agentFiles) {
    const seen = new Set();
    try {
      await forEachJsonLine(path.join(subDir, f), (e) => {
        const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
        if (Number.isNaN(ts)) return; // NaN only — a real epoch-0 line (ts===0) is legitimate
        const msg = e.message;
        if (msg && msg.usage && !(msg.id && seen.has(msg.id))) {
          if (msg.id) seen.add(msg.id);
          const hour = hourKeyOf(ts);
          addUsageSplit((daily[hour] ||= {}), (advisorDaily[hour] ||= {}), msg.model, msg.usage);
        }
      });
    } catch { failed = true; } // a broken sub-agent file surfaces as a partial marker, not a silent drop
  }
  return { any: true, daily, advisorDaily, failed };
}

// Parse one Claude transcript into per-hour per-model totals (parent turns) and the
// same for its sub-agents, then fold the sub-agent spend into the parent's hour so a
// bucket's total reflects work done on the session's behalf. message.id dedup per
// transcript (multi-block turns repeat the same usage); an id-less line is counted.
// The `daily` property name predates the switch to hour keys and is kept deliberately:
// it is part of the persisted cache shape, and renaming it would either strand or
// discard every already-cached entry — the one thing this cache must never do.
async function claudeDaily(file, since = 0) {
  const parent = {}; // hourKey -> totalsByModel
  const parentAdvisor = {}; // hourKey -> totalsByModel ("of which" advisor, own turns)
  const seen = new Set();
  const inlineSubs = []; // legacy fallback: { hourKey, model, usage } on tool_result lines
  let failed = false;
  try {
    await forEachJsonLine(file, (e) => {
      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (Number.isNaN(ts)) return; // NaN only — a real epoch-0 line (ts===0) is legitimate
      // A fork's transcript replays the parent's whole history verbatim, so the
      // dedup-by-file below can't see it (a fork IS a new file) — skip everything
      // before the fork's launch. Mirrors transcript-reader.js scanLine's bound.
      if (since > 0 && ts < since) return;
      const hour = hourKeyOf(ts);
      const msg = e.message;
      if (msg && msg.usage && !(msg.id && seen.has(msg.id))) {
        if (msg.id) seen.add(msg.id);
        addUsageSplit((parent[hour] ||= {}), (parentAdvisor[hour] ||= {}), msg.model, msg.usage);
      }
      const tur = e.toolUseResult;
      if (tur && typeof tur === 'object' && tur.usage && tur.agentType) {
        inlineSubs.push({ hour, model: tur.resolvedModel, usage: tur.usage });
      }
    });
  } catch { failed = true; } // partial/failed read is flagged upstream, never swallowed into a silent $0
  const sessionId = path.basename(file, '.jsonl');
  const bg = await backgroundSubDaily(path.join(path.dirname(file), sessionId, 'subagents'));
  const sub = {}; // hourKey -> totalsByModel (sub-agents only)
  const advisor = {}; // hourKey -> totalsByModel ("of which" advisor, parent + sub-agents)
  if (bg.any) {
    for (const [hour, t] of Object.entries(bg.daily)) mergeInto((sub[hour] ||= {}), t);
    for (const [hour, t] of Object.entries(bg.advisorDaily)) mergeInto((advisor[hour] ||= {}), t);
  } else {
    for (const s of inlineSubs) addUsageSplit((sub[s.hour] ||= {}), (advisor[s.hour] ||= {}), s.model, s.usage);
  }
  for (const [hour, t] of Object.entries(parentAdvisor)) mergeInto((advisor[hour] ||= {}), t);
  // sub's tokens (including its own "of which" advisor share, already inside it via
  // addUsageSplit) fold into parent for the headline; advisor itself is a pure
  // breakout and must NOT be folded in again — parent already has those tokens.
  for (const [hour, t] of Object.entries(sub)) mergeInto((parent[hour] ||= {}), t);
  return { daily: parent, sub, advisor, failed: failed || bg.failed };
}

// Collapse a session's per-hour per-model totals into normalized per-day bags the
// rollup sums directly. usd/tokens are linear in the per-model totals, so summing
// hours into a day then costing equals costing each hour and summing — no precision
// surprise. dayOfKey is what makes this indifferent to the source resolution, so a
// legacy day-keyed cache entry (pre-hour-buckets) flows through here untouched
// instead of needing a migration or, worse, being discarded.
function normalizeClaudeDays(scan) {
  const byDay = {};
  const subByDay = {};
  const advisorByDay = {};
  for (const [key, totals] of Object.entries(scan.daily)) mergeInto((byDay[dayOfKey(key)] ||= {}), totals);
  for (const [key, totals] of Object.entries(scan.sub)) mergeInto((subByDay[dayOfKey(key)] ||= {}), totals);
  // scan.advisor is absent on a raw result cached before this field existed (an
  // unchanged file served straight from claudeFileCache/deletedClaudeTranscript) —
  // default to {} rather than throwing on Object.entries(undefined); that history's
  // advisor share is simply not recoverable until the file changes and gets rescanned.
  for (const [key, totals] of Object.entries(scan.advisor || {})) mergeInto((advisorByDay[dayOfKey(key)] ||= {}), totals);
  const out = {};
  for (const [day, totals] of Object.entries(byDay)) {
    out[day] = {
      usd: costUsd(totals),
      estimatedUsd: 0,
      subAgentUsd: costUsd(subByDay[day] || {}),
      advisorUsd: costUsd(advisorByDay[day] || {}),
      tokens: tokensOf(totals),
      byModel: byModelOf(totals),
      costByType: costUsdByType(totals), // $ split by token type; sums to usd (Claude pricing)
    };
  }
  return out;
}

// ---- transcript index (mirrors cost-report.mjs) ---------------------------
function buildClaudeIndex(projectsDir) {
  const byUuid = new Map();
  const byBucket = new Map();
  for (const bucket of fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : []) {
    let files;
    try { files = fs.readdirSync(path.join(projectsDir, bucket)); } catch { continue; }
    const jsonls = files.filter((f) => f.endsWith('.jsonl'));
    byBucket.set(bucket, jsonls.map((f) => path.join(projectsDir, bucket, f)));
    for (const f of jsonls) byUuid.set(f.slice(0, -6), path.join(projectsDir, bucket, f));
  }
  return { byUuid, byBucket };
}
const bucketName = (cwd) => (cwd || '').replace(/[/.]/g, '-');
function resolveClaudeTranscript(cardId, entry, index, projectsDir) {
  for (const id of [entry.liveSessionId, cardId].filter(Boolean)) {
    if (index.byUuid.has(id)) return index.byUuid.get(id);
  }
  const files = index.byBucket.get(bucketName(entry.cwd));
  if (files && files.length === 1) return files[0];
  return deletedClaudeTranscript(cardId, entry, projectsDir);
}

// Claude Code deletes its own transcripts past cleanupPeriodDays (~30) and that used
// to take the dashboard's history with it: the vanished file drops out of the listing
// above, so it never reaches seenClaudeFiles and scanAllDaily's eviction loop then
// deletes the very cache entry already holding its costed days. A transcript's path is
// COMPUTABLE without a listing, so resolve to that same key and the cached result
// survives as the permanent record (claudeDailyCached hands it back once the file is
// unreadable). Reads claudeFileCache, which scanAllDaily loads before it resolves
// anything.
//
// Gated on actually holding a cache entry claudeDailyCached will SERVE — same file, same
// fork bound — because resolving unconditionally would point every never-scanned entry at
// a phantom path and read-fail it, permanently inflating failedFiles (the UI's "totals
// may be understated" note) with unactionable noise. Nothing servable means nothing to
// recover, so stay unresolved exactly as before. The bound is recomputed here rather than
// threaded through: `since` is stored on the entry but is NOT part of the cache key (the
// key is the file, and two card ids can share one), so presence alone wouldn't tell us
// the hit will land.
//
// LAST, after both live-listing resolutions — never ahead of the single-file-in-bucket
// heuristic, tempting as an exact id match looks. An entry whose liveSessionId names a
// deleted file inside a bucket holding one LIVE jsonl resolves to that live file today;
// jumping the queue would displace it, drop it from seenClaudeFiles and evict its own
// still-recoverable cache entry.
function deletedClaudeTranscript(cardId, entry, projectsDir) {
  const bucket = bucketName(entry.cwd);
  const since = usageSince(entry); // exactly what scanAllDaily will pass to claudeDailyCached
  for (const id of [entry.liveSessionId, cardId].filter(Boolean)) {
    const file = path.join(projectsDir, bucket, `${id}.jsonl`);
    const cached = claudeFileCache && claudeFileCache.get(file);
    if (cached && (cached.since || 0) === since) return file;
  }
  return null;
}

// Task attribution as {key, name}. Prefer the live assignment; when it's gone
// (an archived session whose task was later deleted drops its assignments entry
// but keeps a snapshot on entry.task), fall back to that snapshot; else unassigned.
function taskInfoFor(cardId, entry, assignments, taskNameById) {
  const tid = assignments[cardId];
  if (tid && tid !== 'adhoc') {
    const name = taskNameById.get(tid);
    if (name) return { key: tid, name };
  }
  if (entry.task && entry.task.name) return { key: entry.task.id || `snap:${entry.task.name}`, name: entry.task.name };
  return { key: 'adhoc', name: '(unassigned)' };
}

// ---- per-file scan cache ---------------------------------------------------
// scanAllDaily used to re-read and re-parse EVERY transcript on EVERY call —
// wasteful once most sessions are closed and will never change again. Cache the
// (raw, pre-costing) per-hour totals per transcript file, keyed on whether that
// file has actually changed since it was last read, so a scan only does real
// work for sessions that changed since the last look. Persisted to disk so a
// server restart doesn't force one giant re-scan either.
//
// Two properties make this fit to be the permanent record it becomes once the source
// transcript is deleted: totals are RAW TOKENS PER MODEL, not costed $ (so history can
// be re-priced when rates change, and a pricing bug is fixable retroactively), and they
// are bucketed per HOUR (so day / week / month views are all derivable, and an hourly
// one stays possible). Neither is recoverable later — coarsening or pre-costing here
// silently throws away history that no longer exists anywhere else.
//
// Deliberately NOT byte-offset/incremental tailing within a changed file — a
// file that changed at all is reparsed in full via the existing claudeDaily/
// analyzeCodex, unmodified. Safe partial tailing needs a resume point pinned to
// the last CONFIRMED newline (not "current file size"), else a torn line from a
// concurrently-written active session gets silently skipped forever — not
// worth the complexity here.
const USAGE_CACHE_VERSION = 3; // 3: hour-bucketed keys (2: fork-bounded results; v1 was unbounded)
// v2 is READ but never written: its day keys are a coarser case of the same shape, which
// dayOfKey already handles. Accepting it is load-bearing, not politeness — a version
// mismatch DISCARDS the whole blob, and for any transcript Claude Code has since deleted
// that blob is the only surviving record of the spend. Bumping without this would destroy
// exactly the history the fallback above exists to protect.
const READABLE_CACHE_VERSIONS = new Set([USAGE_CACHE_VERSION, 2]);
const USAGE_CACHE_FILE = 'usage-scan-cache.json';
const STAT_YIELD_EVERY = 100;

let claudeFileCache = null; // Map<absPath, {size, subSig, result}> — result is claudeDaily(file)'s raw {daily, sub, failed}
let codexFileCache = null; // Map<absPath, {mtimeMs, result}> — result is analyzeCodex(...)'s return
let usageFileCacheDirty = false; // set on any add/update/evict; gates the disk write so an all-unchanged scan writes nothing
let usageFileCacheStats = { hits: 0, misses: 0 }; // test seam — real per-file cache effectiveness, not just correctness

function usageCacheFilePath(dataDir) {
  return path.join(dataDir, USAGE_CACHE_FILE);
}

// Lazy: only the FIRST scanAllDaily call in a process attempts the disk read.
// A version mismatch (or missing file) discards the whole cache rather than
// trusting a stale-shaped result — cheap insurance against a future change to
// claudeDaily/analyzeCodex's return shape tripping on the very next restart.
function loadUsageFileCaches(dataDir) {
  if (claudeFileCache && codexFileCache) return;
  const disk = readJsonOrLoud(usageCacheFilePath(dataDir), USAGE_CACHE_FILE);
  if (disk && READABLE_CACHE_VERSIONS.has(disk.version)) {
    claudeFileCache = new Map(Object.entries(disk.claude || {}));
    codexFileCache = new Map(Object.entries(disk.codex || {}));
  } else {
    claudeFileCache = new Map();
    codexFileCache = new Map();
  }
  usageFileCacheDirty = false;
}

// Rewrites the WHOLE cache blob (not just what changed) — fine at today's scale
// since only a user-triggered scan (never a poll) can mark it dirty, but would
// need chunking if the cache ever grew large enough to make a sync write costly.
function persistUsageFileCachesIfDirty(dataDir) {
  if (!usageFileCacheDirty) return;
  try {
    writeJsonAtomic(usageCacheFilePath(dataDir), {
      version: USAGE_CACHE_VERSION,
      claude: Object.fromEntries(claudeFileCache),
      codex: Object.fromEntries(codexFileCache),
    });
  } catch { /* best-effort — a failed write must not break the live dashboard */ }
  usageFileCacheDirty = false;
}

// Test seam: drop BOTH the Maps and the "already loaded" gate, so a reset
// genuinely simulates a fresh process (the next scan reloads from disk) rather
// than just clearing data the lazy-load guard would otherwise skip re-reading.
export function _resetUsageFileCache() {
  claudeFileCache = null;
  codexFileCache = null;
  usageFileCacheDirty = false;
  usageFileCacheStats = { hits: 0, misses: 0 };
}
export function _usageFileCacheStats() {
  return { ...usageFileCacheStats };
}

// A cheap signature of a session's subagents/ dir (sorted name:size pairs, no
// content reads) so a background sub-agent still writing while its parent
// transcript is otherwise idle still invalidates the cache — the parent file's
// own size alone wouldn't show that change.
function subDirSignature(subDir) {
  let files;
  try { files = fs.readdirSync(subDir).filter((f) => /^agent-.+\.jsonl$/.test(f)); } catch { return ''; }
  return files.sort().map((f) => {
    let size = '?';
    try { size = fs.statSync(path.join(subDir, f)).size; } catch { /* keep '?' — still a valid, comparable signature */ }
    return `${f}:${size}`;
  }).join(',');
}

async function claudeDailyCached(file, since = 0) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    // The file is gone (Claude Code's retention sweep). Re-reading it can only fail, so
    // a cached result for the same bound IS the historical record from here on — hand it
    // back, and the caller marking it seen keeps it out of the eviction loop. Checked
    // before subDirSignature: the cached result already folds in sub-agent spend, and
    // that dir may or may not have been deleted alongside the parent.
    const gone = claudeFileCache.get(file);
    if (gone && (gone.since || 0) === since) {
      usageFileCacheStats.hits += 1;
      return gone.result;
    }
    return claudeDaily(file, since); // never cached before deletion: unrecoverable, so let claudeDaily's own catch report the read failure
  }
  const sessionId = path.basename(file, '.jsonl');
  const subSig = subDirSignature(path.join(path.dirname(file), sessionId, 'subagents'));
  const cached = claudeFileCache.get(file);
  // `since` joins the key: the same file costed under a different bound is a
  // different result, and two card ids can resolve to one file (see the dedup below).
  // `cached.result.advisor` gates the hit too — a live, unchanged file whose cached
  // result predates the advisor-breakout field would otherwise serve a `daily` total
  // computed under the old top-level-only read (silently missing advisor spend)
  // forever, since nothing else about the file would ever invalidate it. Missing the
  // field forces one rescan to pick up the new shape; the `gone` branch above is
  // deliberately NOT gated this way (that history is unrecoverable either way).
  if (cached && cached.size === st.size && cached.subSig === subSig && (cached.since || 0) === since && cached.result.advisor) {
    usageFileCacheStats.hits += 1;
    return cached.result;
  }
  usageFileCacheStats.misses += 1;
  const result = await claudeDaily(file, since);
  // Never cache a failed/partial read — a corrupt file must be retried every
  // scan (as before this cache existed), not frozen as a permanent undercount
  // once its size stops changing.
  if (!result.failed) {
    claudeFileCache.set(file, { size: st.size, subSig, since, result });
    usageFileCacheDirty = true;
  }
  return result;
}

async function analyzeCodexCached(analyzeCodex, sessionKey, file, codexSessionsDir, index) {
  const run = () => analyzeCodex(sessionKey, { sessionsDir: codexSessionsDir, index }).catch(() => null);
  let st;
  try { st = fs.statSync(file); } catch { return run(); }
  const cached = codexFileCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    usageFileCacheStats.hits += 1;
    return cached.result;
  }
  usageFileCacheStats.misses += 1;
  const result = await run();
  if (result && result.usd != null) {
    codexFileCache.set(file, { mtimeMs: st.mtimeMs, result });
    usageFileCacheDirty = true;
  }
  return result;
}

// ---- the expensive all-history scan (cached by the caller) ----------------
// Produce, per costed transcript, the task it belongs to and its normalized
// per-day bags across ALL history. Independent of granularity/window so one scan
// serves every dashboard toggle — the rollup then filters + aggregates cheaply.
// This is O(all transcripts on disk); a live server must cache it (see the
// handler), never run it per request.
export async function scanAllDaily({
  dataDir = DEFAULT_DATA_DIR,
  projectsDir = DEFAULT_PROJECTS_DIR,
  codexSessionsDir = DEFAULT_CODEX_SESSIONS_DIR,
} = {}) {
  const mappings = readJson(path.join(dataDir, 'mappings.json'), {});
  const tasks = readJson(path.join(dataDir, 'tasks.json'), {});
  const entries = mappings.sessions || mappings;
  const taskNameById = new Map((tasks.tasks || []).map((t) => [t.id, t.name]));
  const assignments = tasks.assignments || {};
  const index = buildClaudeIndex(projectsDir);
  loadUsageFileCaches(dataDir);

  let analyzeCodex = null;
  let buildRolloutIndex = null;
  try { ({ analyzeCodex, buildRolloutIndex } = await import('./agents/codex-rollout.js')); } catch { /* codex optional */ }
  // Built once on the first Codex entry and reused for every subsequent one, so the
  // sessions tree is walked once per scan, not once per Codex id (was O(sessions²)).
  let codexIndex = null;
  const codexRolloutIndex = async () => (codexIndex ||= buildRolloutIndex ? await buildRolloutIndex(codexSessionsDir) : new Map());

  // Files that read/parse partially or not at all — surfaced so the UI can note the
  // total may be understated, rather than a broken transcript vanishing as a silent $0.
  let failedFiles = 0;
  const raw = []; // { file|null, owner, task, days: { dayKey: bag } }
  // Files actually touched this pass, so a cache entry for anything else (a
  // deleted transcript, a mapping that's gone) gets evicted below rather than
  // lingering forever.
  const seenClaudeFiles = new Set();
  const seenCodexFiles = new Set();
  let statTick = 0;
  const maybeYield = async () => { if ((statTick += 1) % STAT_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r)); };

  for (const [cardId, entry] of Object.entries(entries)) {
    const agent = entry.agent || 'claude';
    const task = taskInfoFor(cardId, entry, assignments, taskNameById);
    if (agent === 'claude') {
      const file = resolveClaudeTranscript(cardId, entry, index, projectsDir);
      if (!file) continue;
      seenClaudeFiles.add(file);
      const cd = await claudeDailyCached(file, usageSince(entry));
      await maybeYield();
      if (cd.failed) failedFiles += 1;
      const days = normalizeClaudeDays(cd);
      if (!Object.keys(days).length) continue;
      const uuid = path.basename(file, '.jsonl');
      const owner = entry.liveSessionId === uuid || cardId === uuid;
      raw.push({ file, owner, task, days });
    } else if (agent === 'codex' && analyzeCodex) {
      // Codex rollouts aren't reliably line-stamped for cost, so attribute the whole
      // (estimated, ChatGPT-plan-equivalent) session to its createdAt day — sub-monthly
      // Codex is approximate. A session with no usable createdAt is skipped, not crashed.
      const created = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
      if (!created) continue;
      const sessionKey = entry.liveSessionId || cardId;
      const rolloutIndex = await codexRolloutIndex();
      const rolloutFile = rolloutIndex.get(sessionKey) || null;
      if (rolloutFile) seenCodexFiles.add(rolloutFile);
      const a = rolloutFile
        ? await analyzeCodexCached(analyzeCodex, sessionKey, rolloutFile, codexSessionsDir, rolloutIndex)
        : await analyzeCodex(sessionKey, { sessionsDir: codexSessionsDir, index: rolloutIndex }).catch(() => null);
      await maybeYield();
      if (!a || a.usd == null) continue;
      const tok = a.tokens || blankTokens();
      const codexTokens = { input: tok.input || 0, output: tok.output || 0, cacheWrite: tok.cacheWrite || 0, cacheRead: tok.cacheRead || 0 };
      const model = a.model || 'gpt-5.5-codex';
      raw.push({
        file: null, owner: true, task,
        days: { [dayKeyOf(created)]: {
          usd: a.usd, estimatedUsd: a.usd, subAgentUsd: 0, advisorUsd: 0,
          tokens: codexTokens,
          // Codex $ is estimated, so its per-model and per-type breakdowns are too.
          byModel: { [model]: { usd: a.usd, estimatedUsd: a.usd, tokens: codexTokens } },
          costByType: a.costByType || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
        } },
      });
    }
  }

  for (const key of [...claudeFileCache.keys()]) {
    if (!seenClaudeFiles.has(key)) { claudeFileCache.delete(key); usageFileCacheDirty = true; }
  }
  for (const key of [...codexFileCache.keys()]) {
    if (!seenCodexFiles.has(key)) { codexFileCache.delete(key); usageFileCacheDirty = true; }
  }
  persistUsageFileCachesIfDirty(dataDir);

  // Dedup by transcript: a resume can re-point a fresh card id at an existing
  // conversation, so two card ids resolve to one file. Keep the true owner, else an
  // assigned card, else the first seen (mirrors cost-report.mjs). Fileless (Codex)
  // rows are always standalone.
  const byFile = new Map();
  const standalone = [];
  for (const s of raw) {
    if (!s.file) { standalone.push(s); continue; }
    const cur = byFile.get(s.file);
    if (!cur) { byFile.set(s.file, s); continue; }
    const better = s.owner && !cur.owner
      ? s
      : (!cur.owner && cur.task.key === 'adhoc' && s.task.key !== 'adhoc' ? s : cur);
    byFile.set(s.file, better);
  }
  return { sessions: [...byFile.values(), ...standalone], generatedAt: new Date().toISOString(), failedFiles };
}

// ---- rollup: day bags -> the requested granularity + window ---------------
// Pure over the scan result, so it's the cheap, unit-tested half of the split. `now`
// is injectable for deterministic tests.
export function rollup(scan, { granularity = 'day', now = Date.now() } = {}) {
  const g = GRANULARITIES.includes(granularity) ? granularity : 'day';
  const { start, end, buckets } = windowFor(g, now);
  const blankByType = () => Object.fromEntries(TYPES.map((t) => [t, { usd: 0, tokens: blankTokens() }]));
  const bucketByKey = new Map(buckets.map((b) => [b.key, {
    key: b.key, start: b.start, end: b.end,
    total: { usd: 0, estimatedUsd: 0, tokens: blankTokens() },
    // Each bucket carries all three slice dimensions; the frontend renders whichever is
    // active. byTask/byModel: key -> {usd, estimatedUsd, tokens}. byType: the fixed four
    // segments, each {usd (the $ share), tokens (only its own slot filled)} so one
    // cellValue reads both metrics off the same shape.
    byTask: {},
    byModel: {},
    byType: blankByType(),
  }]));

  const taskNames = new Map();
  const taskSpend = new Map();
  const modelNames = new Map();
  const modelSpend = new Map();
  const totals = { usd: 0, estimatedUsd: 0, subAgentUsd: 0, advisorUsd: 0, tokens: blankTokens() };
  let estimatedIncluded = false;

  for (const s of scan.sessions) {
    for (const [dayKey, bag] of Object.entries(s.days)) {
      const dayMs = Date.parse(`${dayKey}T00:00:00.000Z`);
      if (!(dayMs >= start && dayMs < end)) continue; // outside the window
      const bkt = bucketByKey.get(periodKeyOf(dayMs, g));
      if (!bkt) continue;

      taskNames.set(s.task.key, s.task.name);
      taskSpend.set(s.task.key, (taskSpend.get(s.task.key) || 0) + bag.usd);
      const cell = (bkt.byTask[s.task.key] ||= { usd: 0, estimatedUsd: 0, tokens: blankTokens() });
      cell.usd += bag.usd; cell.estimatedUsd += bag.estimatedUsd; addTokens(cell.tokens, bag.tokens);

      for (const [model, mb] of Object.entries(bag.byModel || {})) {
        modelNames.set(model, modelLabel(model));
        modelSpend.set(model, (modelSpend.get(model) || 0) + mb.usd);
        const mcell = (bkt.byModel[model] ||= { usd: 0, estimatedUsd: 0, tokens: blankTokens() });
        mcell.usd += mb.usd; mcell.estimatedUsd += mb.estimatedUsd; addTokens(mcell.tokens, mb.tokens);
      }

      const cbt = bag.costByType || {};
      for (const t of TYPES) {
        bkt.byType[t].usd += cbt[t] || 0;
        bkt.byType[t].tokens[t] += bag.tokens[t] || 0; // only this type's own token slot
      }

      bkt.total.usd += bag.usd; bkt.total.estimatedUsd += bag.estimatedUsd; addTokens(bkt.total.tokens, bag.tokens);
      totals.usd += bag.usd; totals.estimatedUsd += bag.estimatedUsd;
      totals.subAgentUsd += bag.subAgentUsd;
      // `|| 0`: a bag built before advisorUsd existed (an unmigrated fixture/cache
      // entry) has no such field — treat it as no advisor spend rather than NaN-ing
      // the running total.
      totals.advisorUsd += bag.advisorUsd || 0;
      addTokens(totals.tokens, bag.tokens);
      if (bag.estimatedUsd > 0) estimatedIncluded = true;
    }
  }

  // A default usd ordering per dimension. The frontend RE-ranks by the active metric so
  // the coloured slots are always the biggest for what's shown (a $-ranking would mis-slot
  // the Tokens view — e.g. cache-read is huge in tokens, tiny in $), but a sensible order
  // here keeps the payload useful on its own. Token type is a fixed set (no fold).
  const rank = (names, spend) => [...names.entries()]
    .map(([key, name]) => ({ key, name, usd: spend.get(key) || 0 }))
    .sort((a, b) => b.usd - a.usd);
  const taskDim = rank(taskNames, taskSpend);
  const dimensions = {
    task: taskDim,
    model: disambiguateNames(rank(modelNames, modelSpend)),
    type: TYPES.map((t) => ({ key: t, name: TYPE_LABELS[t] })),
  };

  return {
    granularity: g,
    generatedAt: scan.generatedAt,
    rangeStart: start,
    rangeEnd: end,
    buckets: [...bucketByKey.values()],
    dimensions,
    tasks: taskDim, // back-compat alias for the Task dimension (dimensions.task)
    totals,
    estimatedIncluded,
    failedFiles: scan.failedFiles || 0,
  };
}

// Convenience: scan (uncached) + rollup. The CLI uses this; the live server caches
// the scan and calls rollup directly so a granularity toggle never rescans disk.
export async function buildUsage({ granularity = 'day', now = Date.now(), ...dirs } = {}) {
  const scan = await scanAllDaily(dirs);
  return rollup(scan, { granularity, now });
}
