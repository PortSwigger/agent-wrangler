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

// Paths only, in readdir order. Split out from allRollouts because resolving ONE
// id needs nothing but the filenames — the uuid is in the name — and a stat per
// file is the expensive half of the walk. Order is deliberately unchanged from
// the stat-ing version: findRollout and buildRolloutIndex both resolve a
// duplicate uuid to the first one walked, and they have to keep agreeing.
async function rolloutPaths(sessionsDir) {
  const out = [];
  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(sessionsDir);
  return out;
}

async function allRollouts(sessionsDir) {
  const out = [];
  for (const full of await rolloutPaths(sessionsDir)) {
    const st = await fsp.stat(full).catch(() => null);
    if (st) out.push({ full, name: path.basename(full), mtimeMs: st.mtimeMs });
  }
  return out;
}

// `${sessionsDir}\0${sessionId}` -> resolved rollout path. Deliberately the same
// shape as transcript-reader.js's pathCache, because it exists for the same
// reason and carries the same two rules:
//
//  - Only POSITIVE results are cached. A miss stays a miss and is re-walked, so
//    a rollout that appears after the first lookup is picked up on the next one
//    rather than being remembered as absent forever. There is no negative-TTL
//    variant: it would buy one directory walk while introducing a chat view that
//    renders empty and does not self-heal for the length of the TTL, and the
//    client has no retry of its own.
//  - A cached hit is re-checked with a cheap existsSync and evicted the moment
//    it stops resolving (the fix #96 had to make for Claude transcripts). A
//    rollout deleted or pruned under a cached path would otherwise freeze that
//    session's chat view and cost forever.
//
// This is what makes the chat view's 2s poll cheap: the first open pays one
// name-only walk of the sessions tree, every poll after it pays one existsSync.
const pathCache = new Map();

export async function findRollout(sessionId, sessionsDir = CODEX_SESSIONS) {
  const key = `${sessionsDir}\0${sessionId}`;
  const hit = pathCache.get(key);
  if (hit) {
    if (fs.existsSync(hit)) return hit;
    pathCache.delete(key);
  }
  let found = null;
  for (const full of await rolloutPaths(sessionsDir)) {
    if (uuidFromName(path.basename(full)) === sessionId) {
      found = full;
      break;
    }
  }
  if (found) pathCache.set(key, found);
  return found;
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

// Every build of the Codex CLI up to ~2026-08-19 wrote EventMsg-shaped
// `user_message`/`agent_message` lines (`payload.type`) alongside the raw
// conversation, and this file's summary/activity logic was written against
// that shape. Every build since drops those mirror lines entirely — verified
// against real rollouts on disk: every one from before that date has at least
// one `user_message`, every one from on/after it has zero — so a Codex session
// dispatched today never gets a `summary`, silently falling back to a bare cwd
// basename for its board title (and, separately, `activityInRangeCodex` always
// reporting zero messages). The only shape left is `response_item` entries
// with `payload.type === 'message'` and a `role` — the same shape
// chat-events.js already had to switch the chat view to. Both shapes are
// checked below (never just the new one) so a still-unarchived pre-8/19
// rollout keeps working.
//
// Mirrors, rather than imports, chat-events.js's combined filter for a Codex
// role:'user' response_item — `isSynthetic(text) || isSyntheticCodex(text)`,
// i.e. the UNION of its generic SYNTHETIC_PREFIXES list (also used for
// Claude's own injected context) and its Codex-specific CODEX_SYNTHETIC_
// PREFIXES one. Take the union, not just the Codex-specific half: chat-
// events.js checks both for a Codex message too, and `<environment_context>`
// in particular — from the generic list — is exactly the tag Codex was
// already known to inject under this same role:'user' shape (the reason the
// pre-response_item version of this file excluded response_item from
// activity counting entirely). Missing it here isn't hypothetical: an earlier
// draft of this fix used only the Codex-specific half and broke this file's
// own test for that exact tag. Most of the generic list's entries (Claude's
// slash-command output wrappers) will never match a Codex rollout — kept
// anyway so this stays a true mirror of the chat view's check rather than a
// second, independently-curated guess at which tags matter. This file is an
// agents/* leaf (must not gain a hard dependency on a UI-facing module), and
// chat-events.js's own header says it deliberately duplicates rather than
// imports for the same reason.
const CODEX_MESSAGE_SYNTHETIC_PREFIXES = [
  '<environment_context>', '<user_instructions>', '<environment_details>',
  '<command-name>', '<command-message>', '<command-args>',
  '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>',
  '<task-notification>',
  '# AGENTS.md instructions', '<recommended_plugins>', '<in-app-browser-context',
  '<user_shell_command>',
];
// A blanket "starts with '<'" check was here originally (matching the legacy
// event_msg path's own `!text.startsWith('<')` below) and was wrong: caught in
// review, it makes a real human message that happens to start with '<'
// (pasted XML/HTML/markdown) look synthetic, undercounting activity and — via
// scanLine/headMetaCodex sharing this same predicate — reproducing the exact
// "falls back to a bare cwd basename" title bug this file exists to fix.
// chat-events.js's isSyntheticCodex has no such blanket rule, only the prefix
// list; match only the list here too.
function isSyntheticCodexMessage(text) {
  const head = text.slice(0, 40).trimStart();
  return CODEX_MESSAGE_SYNTHETIC_PREFIXES.some((prefix) => head.startsWith(prefix));
}
function codexMessageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && ['input_text', 'output_text', 'text'].includes(b.type) && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Shared by scanLine and headMetaCodex, which otherwise each carried a
// near-identical block: pull the human-readable text out of a `response_item`
// line iff it's a real (non-synthetic) role:'user' message, else null.
function responseItemUserText(entry, p) {
  if (entry.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') return null;
  const text = codexMessageText(p.content);
  return text && !isSyntheticCodexMessage(text) ? text : null;
}

// Codex EventMsg payloads are a tagged union under `payload.type`. We read:
//  - turn_context → the model id for pricing
//  - token_count → usage accounting (nested under info.total_token_usage)
//  - user_message → first one becomes the summary (legacy shape; see above)
function scanLine(line, state) {
  if (!line.trim()) return;
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const p = entry.payload || entry;
  const kind = p.type || entry.type;
  if (kind === 'turn_context' && typeof p.model === 'string') {
    state.model = p.model;
    state.pendingModel = p.model;
  }
  if ((kind === 'agent_message' || (entry.type === 'response_item' && p.role === 'assistant')) && state.pendingModel) {
    state.currentModel = state.pendingModel;
  }
  // total_token_usage is cumulative; the last token_count holds the grand total.
  if (kind === 'token_count' && p.info && p.info.total_token_usage) state.usage = p.info.total_token_usage;
  if (!state.summary) {
    if (kind === 'user_message') {
      const text = (typeof p.message === 'string' ? p.message : p.text || '').trim();
      if (text && !text.startsWith('<')) state.summary = text.replace(/\s+/g, ' ').slice(0, 80);
    } else {
      const text = responseItemUserText(entry, p);
      if (text) state.summary = text.replace(/\s+/g, ' ').slice(0, 80);
    }
  }
}

export async function analyzeCodex(sessionId, { sessionsDir = CODEX_SESSIONS, index = null } = {}) {
  const file = index ? index.get(sessionId) || null : await findRollout(sessionId, sessionsDir);
  if (!file) return { usd: null, tokens: null, subAgents: [], summary: null, lastActivity: null };
  const state = { usage: null, model: null, currentModel: null, pendingModel: null, summary: null };
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
    currentModel: state.currentModel || null,
    tokens: { input, output, cacheWrite: 0, cacheRead },
    subAgents: [],
    summary: state.summary,
    lastActivity,
  };
}

// Scan a rollout for real conversation turns whose top-level `timestamp` falls
// in [startMs, endMs). Every rollout line carries a top-level ISO timestamp
// (unlike Claude transcripts, no line-by-line presence check needed). Mirrors
// transcript-reader.js's activityInRange for Claude.
//
// Two shapes exist across the corpus, for the reason scanLine's header
// documents at length: legacy event_msg `user_message`/`agent_message` lines
// (rollouts from before the Codex CLI dropped that shape, ~2026-08-19), and —
// the only shape current rollouts carry — `response_item` entries with
// `payload.type === 'message'`. They are NOT alternatives to OR together: on a
// pre-8/19 rollout BOTH shapes are present for the same turn (chat-events.js's
// own comment: "event_msg/agent_message and user_message repeat
// response_item/message verbatim"), so counting whichever line matched would
// double the true turn count on every legacy rollout. Two independent tallies
// are kept instead and the response_item one wins whenever it saw anything —
// it's what every rollout since 8/19 has, and is never partial on an older
// one, since a legacy rollout carries both shapes in full. The legacy tally is
// the fallback for exactly the files where response_item genuinely has
// nothing (very old Codex CLI builds, if any still exist on disk).
//
// A `role: 'developer'` message (injected instructions) is never conversation
// and is excluded outright. A `role: 'user'` message CAN still be Codex's own
// injected context rather than something the human typed — the original
// comment here warned that a synthetic <environment_context> block arrives
// under this exact shape with no corresponding event_msg turn, which would
// double-count/miscount a turn nobody typed — so it only counts once
// `isSyntheticCodexMessage` says it looks like real prose, the same rule the
// chat view uses to decide what a human actually sees. A `role: 'assistant'`
// message always counts, matching the old unconditional `agent_message` count.
export async function activityInRangeCodex(sessionId, startMs, endMs, sessionsDir = CODEX_SESSIONS) {
  const file = await findRollout(sessionId, sessionsDir);
  if (!file) return null;
  const legacy = { messageCount: 0, firstActivity: null, lastActivity: null };
  const current = { messageCount: 0, firstActivity: null, lastActivity: null };
  const bump = (tally, t) => {
    tally.messageCount += 1;
    if (tally.firstActivity == null || t < tally.firstActivity) tally.firstActivity = t;
    if (tally.lastActivity == null || t > tally.lastActivity) tally.lastActivity = t;
  };
  try {
    const text = await fsp.readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (typeof entry.timestamp !== 'string') continue;
      const p = entry.payload || entry;
      const kind = p.type || entry.type;
      let tally = null;
      if (kind === 'user_message' || kind === 'agent_message') {
        tally = legacy;
      } else if (entry.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
        tally = current;
      } else if (responseItemUserText(entry, p)) {
        tally = current;
      }
      if (!tally) continue;
      const t = Date.parse(entry.timestamp);
      if (!t || t < startMs || t >= endMs) continue;
      bump(tally, t);
    }
  } catch {
    /* rollout unreadable */
  }
  return current.messageCount > 0 ? current : legacy;
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
      if (!summary) {
        if (kind === 'user_message' || kind === 'UserMessage') {
          const text2 = (typeof p.message === 'string' ? p.message : p.text || '').trim();
          if (text2 && !text2.startsWith('<')) summary = text2.replace(/\s+/g, ' ').slice(0, 80);
        } else {
          const text2 = responseItemUserText(entry, p);
          if (text2) summary = text2.replace(/\s+/g, ' ').slice(0, 80);
        }
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
