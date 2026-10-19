import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { piAgentDir } from './pi-catalog.js';

// Pi's session files: `<sessions>/--<cwd>--/<timestamp>_<session-id>.jsonl`, one
// JSON object per line, the first a `{type:"session", id, cwd}` header. The
// wrangler presets the id (`pi --session-id`), so a lookup is a filename match
// across the cwd buckets, the same shape Claude's project buckets have.
export function piSessionsDir(env = process.env) {
  return env.PI_CODING_AGENT_SESSION_DIR || path.join(piAgentDir(env), 'sessions');
}

const pathCache = new Map();

export async function findPiSession(sessionId, sessionsDir = piSessionsDir()) {
  if (!sessionId) return null;
  const key = `${sessionsDir}\0${sessionId}`;
  const cached = pathCache.get(key);
  if (cached && fs.existsSync(cached)) return cached;
  const suffix = `_${sessionId}.jsonl`;
  let found = null;
  try {
    for (const d of await fsp.readdir(sessionsDir)) {
      let names;
      try { names = await fsp.readdir(path.join(sessionsDir, d)); } catch { continue; }
      const hit = names.find((n) => n.endsWith(suffix));
      if (hit) { found = path.join(sessionsDir, d, hit); break; }
    }
  } catch {
    /* sessions dir missing */
  }
  if (found) pathCache.set(key, found);
  return found;
}

async function readEntries(file) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line mid-write */ }
  }
  return out;
}

// The directory the session was started in (its header's cwd), which is the
// bucket `pi --session <id>` resolves from.
export async function piLaunchCwd(sessionId, sessionsDir) {
  const file = await findPiSession(sessionId, sessionsDir);
  if (!file) return null;
  const [header] = await readEntries(file);
  return header?.type === 'session' && typeof header.cwd === 'string' ? header.cwd : null;
}

function userText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
  return '';
}

const EMPTY = { usd: null, subAgentUsd: 0, advisorUsd: 0, tokens: null, subAgents: [] };

// Cost and the board's enrichment fields from a pi session file. Pi prices each
// response itself (`usage.cost.total` on every assistant message, and on the
// `usage` entries it records for work outside the context, such as cache
// warming), so this sums what pi charged rather than re-pricing it.
export async function analyzePi(sessionId, { sessionsDir, since } = {}) {
  const file = await findPiSession(sessionId, sessionsDir);
  if (!file) return EMPTY;
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let usd = 0;
  let priced = false;
  let summary = null;
  let currentModel = null;
  let lastActivity = 0;
  for (const e of await readEntries(file)) {
    const t = Date.parse(e.timestamp);
    if (Number.isFinite(t) && t > lastActivity) lastActivity = t;
    const usage = e.type === 'usage' ? e.usage : e.type === 'message' && e.message?.role === 'assistant' ? e.message.usage : null;
    if (e.type === 'message' && e.message?.role === 'user' && !summary) summary = userText(e.message).trim().slice(0, 200) || null;
    if (e.type === 'message' && e.message?.role === 'assistant' && e.message.model) currentModel = e.message.model;
    if (!usage || (since && Number.isFinite(t) && t < since)) continue;
    tokens.input += usage.input || 0;
    tokens.output += usage.output || 0;
    tokens.cacheRead += usage.cacheRead || 0;
    tokens.cacheWrite += usage.cacheWrite || 0;
    if (Number.isFinite(usage.cost?.total)) { usd += usage.cost.total; priced = true; }
  }
  return {
    ...EMPTY,
    usd: priced ? usd : null,
    tokens,
    lastActivity: lastActivity || null,
    summary,
    aiTitle: null,
    currentModel,
    apiError: false,
  };
}

// The conversation's user and assistant turns with text, oldest first, for
// read_session_transcript: [{ role, ts, text }]. Tool calls, thinking and the
// system loadout entries are left out, as the chat scanners leave them out.
export async function piTurns(file) {
  const out = [];
  for (const e of await readEntries(file)) {
    const role = e.type === 'message' ? e.message?.role : null;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = userText(e.message).trim();
    if (text) out.push({ role, ts: Date.parse(e.timestamp) || null, text });
  }
  return out;
}

// Same contract as transcript-reader's activityInRange: null when the session
// has no file, else the count and span of its message entries in the range.
export async function piActivityInRange(sessionId, startMs, endMs, sessionsDir) {
  const file = await findPiSession(sessionId, sessionsDir);
  if (!file) return null;
  let messageCount = 0;
  let firstActivity = null;
  let lastActivity = null;
  for (const e of await readEntries(file)) {
    if (e.type !== 'message' || e.message?.role === 'system') continue;
    const t = Date.parse(e.timestamp);
    if (!t || t < startMs || t >= endMs) continue;
    messageCount += 1;
    if (firstActivity == null || t < firstActivity) firstActivity = t;
    if (lastActivity == null || t > lastActivity) lastActivity = t;
  }
  return { messageCount, firstActivity, lastActivity };
}

export function _resetPiSessionCacheForTest() {
  pathCache.clear();
}
