#!/usr/bin/env node
// Calendar-month cost report for agent-wrangler sessions.
//
// Recomputes spend straight from the on-disk Claude/Codex transcripts (not the
// board's cached numbers), so it is correct regardless of whether a session's
// card id matches its conversation uuid. Usage is attributed to a month by the
// *timestamp of each transcript line*, so a session spanning a month boundary is
// split correctly. Rates come from server/pricing.js — the single source of
// truth — so this report tracks any price change automatically.
//
// Usage:
//   node scripts/cost-report.mjs [YYYY-MM] [--top N] [--json]
//   node scripts/cost-report.mjs            # current month, top 15, table
//   node scripts/cost-report.mjs 2026-06 --top 25
//   node scripts/cost-report.mjs 2026-06 --json > june.json

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { costUsd, costUsdByType } from '../server/pricing.js';

const HOME = os.homedir();
const DATA_DIR = process.env.AW_DATA_DIR || path.join(HOME, '.agent-wrangler');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// ---- args ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const topIdx = argv.indexOf('--top');
const TOP = topIdx !== -1 && argv[topIdx + 1] ? Number(argv[topIdx + 1]) : 15;
const JSON_OUT = flags.has('--json');

const now = new Date();
const month = positional.find((a) => /^\d{4}-\d{2}$/.test(a))
  || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const monthStart = Date.parse(`${month}-01T00:00:00.000Z`);
const [my, mm] = month.split('-').map(Number);
const monthEnd = Date.parse(`${mm === 12 ? my + 1 : my}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}-01T00:00:00.000Z`);

// ---- stores -------------------------------------------------------------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const mappings = readJson(path.join(DATA_DIR, 'mappings.json'), {});
const tasks = readJson(path.join(DATA_DIR, 'tasks.json'), {});
const entries = mappings.sessions || mappings;
const taskNameById = new Map((tasks.tasks || []).map((t) => [t.id, t.name]));
const assignments = tasks.assignments || {};
function taskNameFor(cardId) {
  const tid = assignments[cardId];
  if (!tid || tid === 'adhoc') return '(unassigned)';
  return taskNameById.get(tid) || '(unknown task)';
}

// ---- transcript index ---------------------------------------------------
// One pass over ~/.claude/projects: map every transcript uuid -> path, and each
// bucket -> its list of transcripts, so the single-file fallback is cheap.
const byUuid = new Map();
const byBucket = new Map();
for (const bucket of fs.existsSync(PROJECTS_DIR) ? fs.readdirSync(PROJECTS_DIR) : []) {
  let files;
  try { files = fs.readdirSync(path.join(PROJECTS_DIR, bucket)); } catch { continue; }
  const jsonls = files.filter((f) => f.endsWith('.jsonl'));
  byBucket.set(bucket, jsonls.map((f) => path.join(PROJECTS_DIR, bucket, f)));
  for (const f of jsonls) byUuid.set(f.slice(0, -6), path.join(PROJECTS_DIR, bucket, f));
}
const bucketName = (cwd) => (cwd || '').replace(/[/.]/g, '-');

// Resolve a Claude session's transcript: exact id (live or card), else the lone
// file in the launch-cwd bucket. Same precedence the board uses, plus the
// single-file fallback for decoupled ids whose live id was never recorded.
function resolveClaudeTranscript(cardId, entry) {
  for (const id of [entry.liveSessionId, cardId].filter(Boolean)) {
    if (byUuid.has(id)) return byUuid.get(id);
  }
  const files = byBucket.get(bucketName(entry.cwd));
  if (files && files.length === 1) return files[0];
  return null;
}

// Every transcript the card has owned, current first. `/clear` abandons the running
// conversation for a fresh id in the same pane, and the board records the outgoing id
// in `priorLiveSessionIds` — the pre-clear spend is real and belongs to this card, so
// the report has to add it up the same way the board does. Prior ids resolve by exact
// id only; the single-file-in-bucket guess is for the one live conversation.
function resolveClaudeTranscripts(cardId, entry) {
  const out = [];
  const add = (file) => { if (file && !out.includes(file)) out.push(file); };
  add(resolveClaudeTranscript(cardId, entry));
  for (const id of entry.priorLiveSessionIds || []) add(byUuid.get(id));
  return out;
}

// ---- usage accumulation (mirrors server/transcript-reader.js addUsage) ---
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

// Add one per-model totals bag into another (same shape addUsage builds).
function mergeInto(dest, src) {
  for (const [model, t] of Object.entries(src)) {
    const d = (dest[model] ||= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
    d.input += t.input; d.output += t.output;
    d.cacheWrite5m += t.cacheWrite5m; d.cacheWrite1h += t.cacheWrite1h; d.cacheRead += t.cacheRead;
  }
}

// Mirrors transcript-reader.js addUsageSplit / usage-report.js's copy: a turn's real
// API calls live in usage.iterations[], each classified "message" or
// "advisor_message" (the native advisor tool, its own `model`, never cached).
// Top-level usage fields do NOT reliably equal the sum of the "message" iterations
// once `iterations` exists — real turns have been found where the top level
// under-reports ordinary "message" tokens too (not just the advisor's), whenever an
// "advisor_message" iteration is bundled into the same turn. Advisor tokens land in
// `totals` too, bucketed under `${model} (advisor)` rather than the bare model id — even when
// the advisor happens to be the same model the parent turn used, its spend stays a
// visibly separate row in the By-model table, not merged into ordinary usage of that
// model. pricing.js's substring match still resolves the suffixed key to the right
// rate. advisorTotals is an "of which" breakout for the report's separate line, not
// an addition on top.
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

// Sum per-turn usage from every agent-*.jsonl under a session's subagents/ dir
// (modern async sub-agents get their own transcript), month-gated per line with
// per-file message.id dedup — mirrors transcript-reader.js scanSubLine. `any` marks
// that the session HAS background sub-agent transcripts (so they, not the parent's
// inline aggregate, are the cost source — the same precedence analyze() uses).
async function backgroundSubTotals(subDir) {
  let files;
  try { files = await fsp.readdir(subDir); } catch { return { any: false, totals: {}, advisorTotals: {} }; }
  const agentFiles = files.filter((f) => /^agent-.+\.jsonl$/.test(f));
  if (!agentFiles.length) return { any: false, totals: {}, advisorTotals: {} };
  const totals = {};
  const advisorTotals = {};
  for (const f of agentFiles) {
    const seen = new Set();
    let content;
    try { content = await fsp.readFile(path.join(subDir, f), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (!ts || ts < monthStart || ts >= monthEnd) continue;
      const msg = e.message;
      if (msg && msg.usage && !(msg.id && seen.has(msg.id))) {
        if (msg.id) seen.add(msg.id);
        addUsageSplit(totals, advisorTotals, msg.model, msg.usage);
      }
    }
  }
  return { any: true, totals, advisorTotals };
}

// The usage bound for a mapping entry — DUPLICATED from transcript-reader.js
// usageSince() under this file's standing convention (the report re-implements the
// board's counting so the two agree; keep them in sync). `claude --resume <parent>
// --fork-session` replays the parent's entire history into the fork's own transcript
// — identical message.ids and timestamps, only the per-line sessionId rewritten — so
// costing a fork's file whole re-bills the parent. Every copied line predates the
// fork's launch, which makes createdAt an exact cut. Codex is deliberately unbounded:
// its rollout carries only a CUMULATIVE total, so a time bound cannot work there.
function usageSince(entry) {
  return entry?.forkedFrom && entry.createdAt ? entry.createdAt : 0;
}

// Parse one transcript, returning per-model token totals for lines whose
// timestamp falls inside [monthStart, monthEnd), PLUS the spend of any sub-agents
// this session dispatched (their own turns are billed too). Claude Code writes one
// line per content block (thinking/text/tool_use) of a turn, each repeating the
// same usage for that one API call — dedup by message.id (per transcript) so a
// multi-block turn is billed once, not 2-3x. An id-less line is always counted.
// Returns the COMBINED totals (parent + sub-agents) so every downstream aggregate
// reflects true spend, and subAgentUsd — the sub-agent portion — for the breakdown.
async function monthTotalsFor(file, since = 0) {
  const totals = {};
  const advisorTotals = {}; // "of which" — already inside totals via addUsageSplit
  const seenUsageIds = new Set();
  const inlineSubs = []; // legacy fallback: { model, usage } for in-range tool_results
  let lines;
  try { lines = (await fsp.readFile(file, 'utf8')).split('\n'); } catch { return { totals, subAgentUsd: 0, advisorUsd: 0 }; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!ts || ts < monthStart || ts >= monthEnd) continue;
    if (since > 0 && ts < since) continue; // inherited fork history — see usageSince
    const msg = e.message;
    if (msg && msg.usage && !(msg.id && seenUsageIds.has(msg.id))) {
      if (msg.id) seenUsageIds.add(msg.id);
      addUsageSplit(totals, advisorTotals, msg.model, msg.usage);
    }
    // A legacy (synchronous) sub-agent leaves only this aggregate on the parent's
    // tool_result — its own turns aren't on disk. A lower bound, used only when the
    // session has no background sub-agent transcripts (see below).
    const tur = e.toolUseResult;
    if (tur && typeof tur === 'object' && tur.usage && tur.agentType) {
      inlineSubs.push({ model: tur.resolvedModel, usage: tur.usage });
    }
  }
  const sessionId = path.basename(file, '.jsonl');
  const bg = await backgroundSubTotals(path.join(path.dirname(file), sessionId, 'subagents'));
  const subTotals = {};
  if (bg.any) {
    mergeInto(subTotals, bg.totals);
    mergeInto(advisorTotals, bg.advisorTotals); // bg.totals already includes it — breakout only
  } else {
    for (const s of inlineSubs) addUsageSplit(subTotals, advisorTotals, s.model, s.usage);
  }
  mergeInto(totals, subTotals);
  return { totals, subAgentUsd: costUsd(subTotals), advisorUsd: costUsd(advisorTotals) };
}

function tokensOf(totals) {
  let input = 0, output = 0, cacheWrite = 0, cacheRead = 0;
  for (const t of Object.values(totals)) {
    input += t.input; output += t.output;
    cacheWrite += t.cacheWrite5m + t.cacheWrite1h; cacheRead += t.cacheRead;
  }
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

// ---- collect per-session ------------------------------------------------
let analyzeCodex = null;
try { ({ analyzeCodex } = await import('../server/agents/codex-rollout.js')); } catch { /* codex optional */ }

const sessions = [];
let unresolved = 0;
for (const [cardId, entry] of Object.entries(entries)) {
  const agent = entry.agent || 'claude';
  const intent = (entry.intent || '').replace(/\s+/g, ' ').trim();
  const label = (intent && intent !== '(resumed)' ? intent.slice(0, 50) : '')
    || entry.name || (entry.cwd ? path.basename(entry.cwd) : '') || cardId.slice(0, 8);
  if (agent === 'claude') {
    const files = resolveClaudeTranscripts(cardId, entry);
    if (!files.length) { unresolved++; continue; }
    // One row per conversation the card has owned, so a cleared-away conversation's
    // spend still lands under the same card and task.
    for (const file of files) {
      const { totals, subAgentUsd, advisorUsd } = await monthTotalsFor(file, usageSince(entry));
      const usd = costUsd(totals);
      const tokens = tokensOf(totals);
      if (tokens.total === 0) continue; // no activity this month (parent or sub-agents)
      const uuid = path.basename(file, '.jsonl');
      const owner = entry.liveSessionId === uuid || cardId === uuid; // true conversation owner vs a re-pointed resume
      sessions.push({ cardId, agent, label, task: taskNameFor(cardId), totals, usd, subAgentUsd, advisorUsd, tokens, estimated: false, file, owner });
    }
  } else if (agent === 'codex' && analyzeCodex) {
    // Codex rollouts aren't line-stamped the same way; attribute the whole
    // session to its createdAt month (estimated ChatGPT-plan pricing).
    const created = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
    if (!created || created < monthStart || created >= monthEnd) continue;
    const a = await analyzeCodex(entry.liveSessionId || cardId).catch(() => null);
    if (!a || a.usd == null) { unresolved++; continue; }
    const tok = a.tokens || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    sessions.push({
      cardId, agent, label, task: taskNameFor(cardId),
      totals: {}, usd: a.usd,
      tokens: { ...tok, total: tok.input + tok.output + tok.cacheWrite + tok.cacheRead },
      estimated: true,
    });
  }
}

// ---- dedup by transcript ------------------------------------------------
// A resume can re-point a fresh card id at an existing conversation, so two card
// ids resolve to one transcript. Count each transcript once: keep the true
// owner, else an assigned card, else the first seen.
const byFile = new Map();
const standalone = [];
for (const s of sessions) {
  if (!s.file) { standalone.push(s); continue; }
  const cur = byFile.get(s.file);
  if (!cur) { byFile.set(s.file, s); continue; }
  const better = s.owner && !cur.owner
    ? s
    : (!cur.owner && cur.task === '(unassigned)' && s.task !== '(unassigned)' ? s : cur);
  byFile.set(s.file, better);
}
const deduped = [...byFile.values(), ...standalone];
const duplicatesDropped = sessions.length - deduped.length;
sessions.length = 0;
sessions.push(...deduped);

// ---- aggregate ----------------------------------------------------------
function blankAgg() { return { cost: 0, sessions: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 } }; }
function addAgg(agg, s) {
  agg.cost += s.usd; agg.sessions += 1;
  for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'total']) agg.tokens[k] += s.tokens[k];
}

const byTask = new Map();
const byModel = new Map();
const grand = blankAgg();
const byType = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }; // Claude only — Codex cost is estimated and not split by type
let estimatedCost = 0;
let subAgentCost = 0; // portion of the (Claude) total spent by dispatched sub-agents
let advisorCost = 0; // portion of the (Claude) total spent on native advisor-tool consults
for (const s of sessions) {
  if (!byTask.has(s.task)) byTask.set(s.task, blankAgg());
  addAgg(byTask.get(s.task), s);
  addAgg(grand, s);
  subAgentCost += s.subAgentUsd || 0;
  advisorCost += s.advisorUsd || 0;
  if (s.estimated) estimatedCost += s.usd;
  else {
    const bt = costUsdByType(s.totals);
    for (const kk of ['input', 'output', 'cacheWrite', 'cacheRead']) byType[kk] += bt[kk];
  }
  const models = Object.keys(s.totals).length ? s.totals : { [s.agent === 'codex' ? 'gpt (codex est.)' : 'unknown']: null };
  for (const model of Object.keys(models)) {
    if (!byModel.has(model)) byModel.set(model, blankAgg());
    const agg = byModel.get(model);
    // Cost/tokens per model from this session's per-model split when available.
    if (s.totals[model]) {
      agg.cost += costUsd({ [model]: s.totals[model] });
      const t = s.totals[model];
      agg.tokens.input += t.input; agg.tokens.output += t.output;
      agg.tokens.cacheWrite += t.cacheWrite5m + t.cacheWrite1h; agg.tokens.cacheRead += t.cacheRead;
      agg.tokens.total += t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
    } else {
      agg.cost += s.usd;
      for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'total']) agg.tokens[k] += s.tokens[k];
    }
    agg.sessions += 1;
  }
}

const topSessions = [...sessions].sort((a, b) => b.usd - a.usd).slice(0, TOP);

// ---- output -------------------------------------------------------------
const report = {
  month, generatedAt: new Date().toISOString(),
  totals: { ...grand, estimatedCostIncluded: estimatedCost, subAgentCostIncluded: subAgentCost, advisorCostIncluded: advisorCost, sessionsConsidered: Object.keys(entries).length, unresolved },
  byTask: [...byTask.entries()].map(([name, a]) => ({ name, ...a })).sort((x, y) => y.cost - x.cost),
  byModel: [...byModel.entries()].map(([name, a]) => ({ name, ...a })).filter((m) => m.cost > 0 || m.tokens.total > 0).sort((x, y) => y.cost - x.cost),
  byType,
  topSessions: topSessions.map((s) => ({ cardId: s.cardId, label: s.label, task: s.task, agent: s.agent, usd: s.usd, subAgentUsd: s.subAgentUsd || 0, advisorUsd: s.advisorUsd || 0, tokens: s.tokens, estimated: s.estimated })),
};

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const usd = (n) => `$${n.toFixed(2)}`;
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n}`);
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);

console.log(`\n  agent-wrangler cost report — ${month} (UTC)\n  ${'='.repeat(52)}`);
console.log(`  Total: ${usd(grand.cost)}  across ${grand.sessions} active sessions  ·  ${k(grand.tokens.total)} tokens`);
console.log(`  Avg/session: ${usd(grand.cost / (grand.sessions || 1))}  ·  ${k(Math.round(grand.tokens.total / (grand.sessions || 1)))} tokens`);
if (estimatedCost > 0) console.log(`  (includes ${usd(estimatedCost)} estimated Codex/ChatGPT-plan spend)`);
if (subAgentCost > 0) console.log(`  (includes ${usd(subAgentCost)} spent by dispatched sub-agents, folded into the totals above)`);
// Deliberately NOT disjoint from the sub-agent figure above — a sub-agent's own
// advisor consult counts in both (each is an independent "of which" slice of the
// same total, not a partition), so don't let the two lines read as separately
// addable.
if (advisorCost > 0) console.log(`  (includes ${usd(advisorCost)} spent on advisor consultations, folded into the totals above — may overlap the sub-agent figure)`);
if (unresolved > 0) console.log(`  (${unresolved} sessions had no recoverable transcript — not counted)`);
if (duplicatesDropped > 0) console.log(`  (${duplicatesDropped} resumed card(s) merged into their shared transcript)`);

console.log(`\n  By task${' '.repeat(28)}cost     sess    avg/sess   tokens`);
console.log(`  ${'-'.repeat(72)}`);
for (const t of report.byTask) {
  console.log(`  ${pad(t.name.slice(0, 32), 33)}${lpad(usd(t.cost), 8)}${lpad(t.sessions, 7)}${lpad(usd(t.cost / (t.sessions || 1)), 11)}   ${k(t.tokens.total)}`);
}

console.log(`\n  By model${' '.repeat(12)}cost     sess    in       out      cacheW   cacheR`);
console.log(`  ${'-'.repeat(72)}`);
for (const m of report.byModel) {
  console.log(`  ${pad(m.name.slice(0, 18), 19)}${lpad(usd(m.cost), 8)}${lpad(m.sessions, 7)}  ${lpad(k(m.tokens.input), 7)}  ${lpad(k(m.tokens.output), 7)}  ${lpad(k(m.tokens.cacheWrite), 7)}  ${lpad(k(m.tokens.cacheRead), 7)}`);
}

const claudeCost = grand.cost - estimatedCost;
console.log(`\n  By token type${' '.repeat(10)}cost     share`);
console.log(`  ${'-'.repeat(72)}`);
for (const [label, key] of [['input (fresh)', 'input'], ['output', 'output'], ['cache write', 'cacheWrite'], ['cache read', 'cacheRead']]) {
  const v = report.byType[key];
  const share = claudeCost > 0 ? `${((100 * v) / claudeCost).toFixed(1)}%` : '—';
  console.log(`  ${pad(label, 19)}${lpad(usd(v), 8)}${lpad(share, 10)}`);
}
if (estimatedCost > 0) console.log(`  (excludes ${usd(estimatedCost)} estimated Codex spend — not split by type)`);

console.log(`\n  Top ${TOP} most expensive sessions`);
console.log(`  ${'-'.repeat(72)}`);
console.log(`  ${pad('cost', 9)}${pad('task', 24)}${pad('session', 40)}`);
for (const s of topSessions) {
  console.log(`  ${pad(usd(s.usd) + (s.estimated ? '~' : ''), 9)}${pad(s.task.slice(0, 22), 24)}${s.label}`);
}
console.log('');
