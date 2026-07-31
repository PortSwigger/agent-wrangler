import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { codexCostUsd, codexCostUsdByType } from '../pricing.js';

const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

function uuidFromName(name) {
  const m = name.match(/^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/);
  return m ? m[1] : null;
}

async function allRollouts(sessionsDir) {
  const out = [];
  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) out.push({ full, name: e.name, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(sessionsDir);
  return out;
}

async function findRollout(sessionId, sessionsDir) {
  for (const r of await allRollouts(sessionsDir)) {
    if (uuidFromName(r.name) === sessionId) return r.full;
  }
  return null;
}

// One sessionId -> rollout-file map for the whole tree, so a caller resolving many
// ids (the usage scan) walks the sessions dir ONCE instead of re-walking per id
// (O(sessions²)). Keeps first-seen on a duplicate uuid, matching findRollout's
// walk-order pick.
export async function buildRolloutIndex(sessionsDir = CODEX_SESSIONS) {
  const byUuid = new Map();
  for (const r of await allRollouts(sessionsDir)) {
    const id = uuidFromName(r.name);
    if (id && !byUuid.has(id)) byUuid.set(id, r.full);
  }
  return byUuid;
}

// Codex EventMsg payloads are a tagged union under `payload.type`. We read:
//  - turn_context → the model id for pricing
//  - token_count → usage accounting (nested under info.total_token_usage)
//  - user_message → first one becomes the summary
function scanLine(line, state) {
  if (!line.trim()) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const p = entry.payload || entry;
  const kind = p.type || entry.type;
  if (kind === 'turn_context' && typeof p.model === 'string') state.model = p.model;
  // total_token_usage is cumulative; the last token_count holds the grand total.
  if (kind === 'token_count' && p.info && p.info.total_token_usage) state.usage = p.info.total_token_usage;
  if (!state.summary && kind === 'user_message') {
    const text = (typeof p.message === 'string' ? p.message : p.text || '').trim();
    if (text && !text.startsWith('<')) state.summary = text.replace(/\s+/g, ' ').slice(0, 80);
  }
}

export async function analyzeCodex(sessionId, { sessionsDir = CODEX_SESSIONS, index = null } = {}) {
  const file = index ? index.get(sessionId) || null : await findRollout(sessionId, sessionsDir);
  if (!file) return { usd: null, tokens: null, subAgents: [], summary: null, lastActivity: null };
  const state = { usage: null, model: null, summary: null };
  let lastActivity = null;
  try {
    const st = await fsp.stat(file);
    lastActivity = Math.round(st.mtimeMs);
    const text = await fsp.readFile(file, 'utf8');
    for (const line of text.split('\n')) scanLine(line, state);
  } catch {
    return { usd: null, tokens: null, subAgents: [], summary: null, lastActivity: null };
  }
  const u = state.usage || {};
  const cacheRead = u.cached_input_tokens || 0;
  const input = Math.max(0, (u.input_tokens || 0) - cacheRead);
  const output = u.output_tokens || 0;
  const model = state.model || 'gpt-5.5-codex';
  const totals = { [model]: { input, output, cacheRead } };
  return {
    usd: codexCostUsd(totals),
    costByType: codexCostUsdByType(totals), // $ split across input/output/cache for the usage dashboard's Token-type slice
    model, // surfaced so the dashboard can attribute Codex spend to its model bucket
    tokens: { input, output, cacheWrite: 0, cacheRead },
    subAgents: [],
    summary: state.summary,
    lastActivity,
  };
}

// Scan a rollout for real conversation turns — event_msg payloads of type
// `user_message`/`agent_message` (the same two kinds scanLine already treats as
// meaningful, e.g. for the summary) — whose top-level `timestamp` falls in
// [startMs, endMs). Every rollout line carries a top-level ISO timestamp (unlike
// Claude transcripts, no line-by-line presence check needed). A `response_item`
// with role "user" is NOT used here: Codex injects a synthetic
// <environment_context> block under that same shape with no corresponding
// user_message event, which would double-count/miscount a turn that was never
// typed by the user. Mirrors transcript-reader.js's activityInRange for Claude.
export async function activityInRangeCodex(sessionId, startMs, endMs, sessionsDir = CODEX_SESSIONS) {
  const file = await findRollout(sessionId, sessionsDir);
  if (!file) return null;
  let messageCount = 0;
  let firstActivity = null;
  let lastActivity = null;
  try {
    const text = await fsp.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const p = entry.payload || entry;
      const kind = p.type || entry.type;
      if ((kind !== 'user_message' && kind !== 'agent_message') || typeof entry.timestamp !== 'string') continue;
      const t = Date.parse(entry.timestamp);
      if (!t || t < startMs || t >= endMs) continue;
      messageCount += 1;
      if (firstActivity == null || t < firstActivity) firstActivity = t;
      if (lastActivity == null || t > lastActivity) lastActivity = t;
    }
  } catch {
    /* rollout unreadable */
  }
  return { messageCount, firstActivity, lastActivity };
}

function headMetaCodex(file) {
  let cwd = null; let summary = null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      const p = entry.payload || entry;
      if (!cwd && p.cwd) cwd = p.cwd;
      const kind = p.type || entry.type;
      if (!summary && (kind === 'user_message' || kind === 'UserMessage')) {
        const text2 = (typeof p.message === 'string' ? p.message : p.text || '').trim();
        if (text2 && !text2.startsWith('<')) summary = text2.replace(/\s+/g, ' ').slice(0, 80);
      }
      if (cwd && summary) break;
    }
  } catch { /* unreadable */ }
  return { cwd, summary };
}

export async function listResumableCodex(excludeIds = new Set(), opts = {}) {
  const { windowDays = 7, now = Date.now(), sessionsDir = CODEX_SESSIONS } = opts;
  const cutoff = now - windowDays * 86_400_000;
  const candidates = [];
  for (const r of await allRollouts(sessionsDir)) {
    const sessionId = uuidFromName(r.name);
    if (!sessionId || excludeIds.has(sessionId) || r.mtimeMs < cutoff) continue;
    const { cwd, summary } = headMetaCodex(r.full);
    candidates.push({ sessionId, cwd, summary, lastActivity: Math.round(r.mtimeMs), agent: 'codex' });
  }
  candidates.sort((a, b) => b.lastActivity - a.lastActivity);
  return { candidates, total: candidates.length, windowDays };
}
