import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_DIR } from './claude-paths.js';
import { costUsd } from './pricing.js';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Consecutive quiet polls (no file growth, no dangling tool_use) required
// before subAgentsFrom commits a background sub-agent to 'completed'. Without
// this grace period, the ordinary gap between finishing one turn and starting
// the next (the model composing its next tool call, writing nothing to disk
// meanwhile) was indistinguishable poll-to-poll from "actually done" — status
// visibly flickered running/completed every time a still-working sub-agent
// paused between tool calls.
const SUBAGENT_QUIET_POLLS = 2;

// sessionId -> { transcript, offset, totals, subAgents, leftover }
const cache = new Map();
// `${projectsDir}\0${sessionId}` -> resolved transcript path. Keyed by the
// projects dir so test dirs can't collide with the real tree. Only *positive*
// results are stored: a freshly launched session is analysed before its first
// turn is written, and caching that miss would leave its cost + last-activity
// blank for the whole session — so a miss is always re-checked until the
// transcript appears, while a found path (which never moves) stays cached.
const pathCache = new Map();

export async function findTranscript(sessionId, projectsDir = PROJECTS_DIR) {
  const key = `${projectsDir}\0${sessionId}`;
  const hit = pathCache.get(key);
  if (hit) return hit;
  let found = null;
  try {
    const dirs = await fsp.readdir(projectsDir);
    for (const d of dirs) {
      const candidate = path.join(projectsDir, d, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  } catch {
    /* projects dir missing */
  }
  if (found) pathCache.set(key, found);
  return found;
}

// The directory Claude was launched in for this session — the one whose project
// bucket stores the transcript. `claude --resume` only locates a session from
// that directory, so resume must run there. A session that later changed cwd
// (e.g. cd'd into a git worktree) still lives under its original launch bucket,
// so we take the cwd from the first transcript record, not the latest.
export async function launchCwd(sessionId, projectsDir) {
  const transcript = await findTranscript(sessionId, projectsDir);
  if (!transcript) return null;
  try {
    const stream = fs.createReadStream(transcript, { encoding: 'utf8' });
    let buf = '';
    for await (const chunk of stream) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.cwd === 'string' && entry.cwd) {
            stream.destroy();
            return entry.cwd;
          }
        } catch {
          /* skip non-JSON line */
        }
      }
    }
  } catch {
    /* transcript unreadable */
  }
  return null;
}

// Pick the directory to (re)launch `claude --resume` in. The recorded launch dir
// wins — it owns the project bucket `--resume` reads. But archived sessions are
// off the board (no graph cwd) and their original transcript may be gone, so fall
// back to the cwd persisted in the mapping; never let it resolve to undefined and
// strand the resume in the home dir, where the session id isn't bucketed.
export async function resolveResumeDir(sessionId, { graphCwd, entryCwd, projectsDir } = {}) {
  return (await launchCwd(sessionId, projectsDir)) || graphCwd || entryCwd || null;
}

// Read just the head of a transcript for its launch cwd + a one-line summary
// (the first non-meta user prompt). Cheap: stops as soon as both are known, so
// discovery can scan hundreds of files without parsing them whole.
async function headMeta(file) {
  let cwd = null;
  let summary = null;
  try {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    let buf = '';
    for await (const chunk of stream) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!cwd && typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd;
        const msg = entry.message;
        if (!summary && msg && (entry.type === 'user' || msg.role === 'user') && !entry.isMeta) {
          let text = '';
          if (typeof msg.content === 'string') text = msg.content;
          else if (Array.isArray(msg.content)) {
            const t = msg.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
            if (t) text = t.text;
          }
          text = (text || '').trim();
          if (text && !text.startsWith('<')) summary = text.replace(/\s+/g, ' ').slice(0, 80);
        }
        if (cwd && summary) {
          stream.destroy();
          return { cwd, summary };
        }
      }
    }
  } catch {
    /* transcript unreadable */
  }
  return { cwd, summary };
}

// path:mtime -> { cwd, summary }. Transcript heads of inactive sessions never
// change, so this keeps repeat opens and the widen-to-30-days action snappy.
const headCache = new Map();
async function cachedHeadMeta(file, mtimeMs) {
  const key = `${file}:${mtimeMs}`;
  let meta = headCache.get(key);
  if (!meta) {
    meta = await headMeta(file);
    headCache.set(key, meta);
  }
  return meta;
}

// Discover resumable Claude sessions from on-disk transcripts that the caller
// (the graph) isn't already showing. `excludeIds` is the set of session ids
// already represented in the live board view (managed) or the history view; we
// skip those, plus any transcript implausibly tiny (a bare startup with no real
// conversation) or last touched outside the recency window. Newest activity
// first. The window is the bound — no silent cap — so `total` always equals the
// number returned; the UI shows "N of total" and offers a wider window.
export async function listResumable(excludeIds = new Set(), opts = {}) {
  const { windowDays = 7, now = Date.now(), projectsDir = PROJECTS_DIR } = opts;
  const cutoff = now - windowDays * 86_400_000;
  let dirs;
  try {
    dirs = await fsp.readdir(projectsDir);
  } catch {
    return { candidates: [], total: 0, windowDays };
  }
  const found = [];
  for (const d of dirs) {
    let files;
    try {
      files = await fsp.readdir(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -6);
      if (excludeIds.has(sessionId)) continue;
      const full = path.join(projectsDir, d, f);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size < 256 || stat.mtimeMs < cutoff) continue;
      found.push({ sessionId, full, lastActivity: stat.mtimeMs });
    }
  }
  found.sort((a, b) => b.lastActivity - a.lastActivity);
  const candidates = [];
  for (const c of found) {
    const { cwd, summary } = await cachedHeadMeta(c.full, c.lastActivity);
    candidates.push({ sessionId: c.sessionId, cwd, summary, lastActivity: Math.round(c.lastActivity) });
  }
  return { candidates, total: candidates.length, windowDays };
}

// Scan a transcript for real conversation turns (entries carrying a `message`)
// whose `timestamp` falls in [startMs, endMs). Returns null when no transcript
// exists for this id at all (distinct from "found but no activity in range",
// which returns messageCount: 0) so callers can tell "never had a transcript"
// from "had one, just not active that day".
export async function activityInRange(sessionId, startMs, endMs, projectsDir = PROJECTS_DIR) {
  const transcript = await findTranscript(sessionId, projectsDir);
  if (!transcript) return null;
  let messageCount = 0;
  let firstActivity = null;
  let lastActivity = null;
  try {
    const stream = fs.createReadStream(transcript, { encoding: 'utf8' });
    let buf = '';
    for await (const chunk of stream) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry.message || typeof entry.timestamp !== 'string') continue;
        const t = Date.parse(entry.timestamp);
        if (!t || t < startMs || t >= endMs) continue;
        messageCount += 1;
        if (firstActivity == null || t < firstActivity) firstActivity = t;
        if (lastActivity == null || t > lastActivity) lastActivity = t;
      }
    }
  } catch {
    /* transcript unreadable */
  }
  return { messageCount, firstActivity, lastActivity };
}

function emptyState(transcript, since = 0) {
  return { transcript, since, offset: 0, totals: {}, subAgentTotals: {}, subAgents: [], legacyAgents: new Map(), subFiles: new Map(), leftover: '', lastActivity: 0, summary: null, aiTitle: null, seenUsageIds: new Set(), apiError: false };
}

// Add one per-model totals bag into another (the shape addUsage builds), so the
// parent's own spend and its sub-agents' can be combined into a session-wide total.
function mergeTotals(dest, src) {
  for (const [model, t] of Object.entries(src)) {
    const d = (dest[model] ||= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
    d.input += t.input;
    d.output += t.output;
    d.cacheWrite5m += t.cacheWrite5m;
    d.cacheWrite1h += t.cacheWrite1h;
    d.cacheRead += t.cacheRead;
  }
}

function addUsage(totals, model, usage) {
  if (!usage) return;
  const key = model || 'unknown';
  const t = (totals[key] ||= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  t.input += usage.input_tokens || 0;
  t.output += usage.output_tokens || 0;
  // cache_creation breaks the write total down by TTL; older transcripts lack it,
  // so fall back to billing the whole creation count at the 5m rate.
  const cc = usage.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    t.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
    t.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
  } else {
    t.cacheWrite5m += usage.cache_creation_input_tokens || 0;
  }
  t.cacheRead += usage.cache_read_input_tokens || 0;
}

export function scanLine(line, state) {
  if (!line.trim()) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  // Last activity = newest entry timestamp seen.
  if (entry.timestamp) {
    const t = Date.parse(entry.timestamp);
    if (t && t > state.lastActivity) state.lastActivity = t;
  }
  if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle) {
    state.aiTitle = entry.aiTitle;
  }
  // `claude --resume <parent> --fork-session` REPLAYS the parent's entire history
  // into the fork's own transcript — identical uuids, message.ids and timestamps,
  // with only the per-line sessionId rewritten — then appends the fork's own turns.
  // So there is no on-disk marker to tell a copied line from an original, and
  // costing the file from byte 0 re-bills the whole parent conversation on the
  // fork's card. `state.since` (the fork's createdAt) is the discriminator: every
  // copied line predates the fork's launch by construction. Bounds SPEND ONLY —
  // summary/lastActivity/apiError deliberately still see the inherited history,
  // because forkEntry inherits the parent's intent and the [FORK] label leans on
  // that summary resolving.
  const inherited = state.since > 0 && entry.timestamp && Date.parse(entry.timestamp) < state.since;
  const msg = entry.message;
  if (!msg) return;
  // A dropped API connection ends the turn on a synthetic assistant message
  // flagged isApiErrorMessage, with no permission request following — so the
  // status file just reports idle, indistinguishable from a normal finish.
  // Track whether the LAST message-bearing line is one of these; any later
  // real turn (retry or a new user message) overwrites it back to false.
  // Sidechain lines (a legacy inline sub-agent's own turns) are excluded — its
  // error is the sub-agent's problem, not the parent conversation's.
  if (!entry.isSidechain) state.apiError = Boolean(entry.isApiErrorMessage);
  // Claude Code writes one transcript line per content block (thinking/text/tool_use)
  // of a single assistant turn, each repeating the same usage for that one API call.
  // Dedup by message.id so a multi-block turn is billed once, not 2-3x; an id-less
  // line (older/synthetic) is always counted since it can't be matched to others.
  if (msg.usage && !inherited && !(msg.id && state.seenUsageIds.has(msg.id))) {
    if (msg.id) state.seenUsageIds.add(msg.id);
    addUsage(state.totals, msg.model, msg.usage);
  }

  // First real user message → a human-readable summary for unnamed sessions.
  if (!state.summary && (entry.type === 'user' || msg.role === 'user') && !entry.isMeta) {
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      const t = msg.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
      if (t) text = t.text;
    }
    text = (text || '').trim();
    if (text && !text.startsWith('<')) state.summary = text.replace(/\s+/g, ' ').slice(0, 80);
  }

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      // Legacy (synchronous) sub-agents live entirely in the parent transcript: a
      // Task→Agent (renamed across harness versions; match both) tool_use, paired
      // later with its tool_result by id — for TIMESTAMPS ONLY, no text retained. A
      // background session ALSO has these blocks; analyze() discards this map when it
      // finds a subagents/ dir, so a modern dispatch isn't double-counted.
      // Skipping an inherited tool_use also drops its tool_result for free — the
      // result only lands if its tool_use_id is already in the map.
      if (block?.type === 'tool_use' && !inherited && (block.name === 'Agent' || block.name === 'Task')) {
        const input = block.input || {};
        const id = block.id || `${state.legacyAgents.size}`;
        state.legacyAgents.set(id, {
          id,
          agentType: input.subagent_type || 'agent',
          label: input.description || input.subagent_type || 'sub-agent',
          startedAt: entry.timestamp ? Date.parse(entry.timestamp) : null,
          endedAt: null,
        });
      }
      // The matching tool_result yields only the completion timestamp; its content
      // is read past and discarded in the same pass.
      if (block?.type === 'tool_result' && block.tool_use_id && state.legacyAgents.has(block.tool_use_id)) {
        const la = state.legacyAgents.get(block.tool_use_id);
        if (entry.timestamp) la.endedAt = Date.parse(entry.timestamp);
        // A legacy sub-agent keeps only this pair in the parent — its own turns are
        // never written to disk — so the tool_result's aggregate `toolUseResult.usage`
        // is the only cost signal we have (a lower bound: it reflects one settle, not
        // every turn). Captured here, folded into the total ONLY when analyze falls
        // back to the legacy path; a modern background sub-agent is costed from its
        // own transcript instead (accurate), so this is ignored there.
        const tur = entry.toolUseResult;
        if (tur && typeof tur === 'object' && tur.usage) {
          la.usage = tur.usage;
          la.model = tur.resolvedModel || null;
        }
      }
    }
  }
}

// Best-effort JSON read of a sub-agent's .meta.json sidecar (agentType/description,
// written at dispatch so it's present even while the agent runs). A missing/corrupt
// sidecar just loses the friendly label, never throws.
function readMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Stateless parse of an already-materialised line set (e.g. streamed via `docker
// cp`/`exec cat` for a devcontainer session) — shares scanLine/summarise with the
// incremental file path below so both surfaces agree on cost/token math, but keeps
// no cache across calls since there's no stable path to key one on.
export function analyzeLines(lines, { since = 0 } = {}) {
  const state = emptyState(null, since);
  for (const line of lines) scanLine(line, state);
  return summarise(state);
}

// Extract just the metadata a poll needs from a background sub-agent transcript,
// threading a per-file cache so tailing is incremental (like analyze's own
// offset/leftover). Retains NO text: timestamps, usage totals, and whether the LAST
// content block seen is a tool_use not yet followed by a tool_result/text.
function tailSubAgentFile(file, fc) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  fc.prevSize = fc.size ?? null; // size at the previous poll (null on first sight)
  if (stat.size < (fc.offset || 0)) {
    // Truncated/rotated — restart this file's cache.
    fc.offset = 0;
    fc.leftover = '';
    fc.totals = {};
    fc.seenUsageIds = new Set();
    fc.startedAt = null;
    fc.endedAt = null;
    fc.dangling = false;
  }
  if (stat.size > (fc.offset || 0)) {
    const fd = fs.openSync(file, 'r');
    try {
      const len = stat.size - (fc.offset || 0);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, fc.offset || 0);
      let buf = (fc.leftover || '') + b.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        scanSubLine(buf.slice(0, nl), fc);
        buf = buf.slice(nl + 1);
      }
      fc.leftover = buf;
    } finally {
      fs.closeSync(fd);
    }
    fc.offset = stat.size;
  }
  fc.size = stat.size;
}

function scanSubLine(line, fc) {
  if (!line.trim()) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const msg = entry.message;
  if (entry.timestamp) {
    const t = Date.parse(entry.timestamp);
    if (t) {
      if (fc.startedAt == null) fc.startedAt = t;
      fc.endedAt = t;
    }
  }
  if (!msg) return;
  // Per-file usage dedup by message.id — a multi-block assistant turn repeats the
  // same usage 2-3x, exactly as the main transcript does (see scanLine).
  if (msg.usage && !(msg.id && fc.seenUsageIds.has(msg.id))) {
    if (msg.id) fc.seenUsageIds.add(msg.id);
    addUsage(fc.totals, msg.model, msg.usage);
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type === 'tool_use') fc.dangling = true;
      else if (block?.type === 'tool_result' || block?.type === 'text') fc.dangling = false;
    }
  }
}

// Discover + incrementally tail background sub-agents from <sessionDir>/subagents. A
// missing dir (no sub-agents ever, or a pre-feature session) is an empty list, not an
// error. Status is an INFERRED heuristic (the format has no explicit done marker, and
// these transcripts are resumable, so silence isn't "finished forever"): running if
// the file grew since the previous poll of this same file, or its last content block
// is a dangling tool_use, or it's within its SUBAGENT_QUIET_POLLS grace period after
// either of those (see the constant's comment); completed otherwise.
export async function subAgentsFrom(subagentsDir, state) {
  let files;
  try {
    files = await fsp.readdir(subagentsDir);
  } catch {
    return [];
  }
  const list = [];
  for (const f of files) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    const id = m[1];
    const fc = state.subFiles.get(id) || {
      offset: 0, leftover: '', totals: {}, seenUsageIds: new Set(),
      startedAt: null, endedAt: null, dangling: false, size: null, meta: null, quietPolls: 0,
    };
    tailSubAgentFile(path.join(subagentsDir, f), fc);
    state.subFiles.set(id, fc);
    // The sidecar never changes after dispatch, so cache it on the per-file entry
    // rather than re-reading synchronously on every ~4s poll (mirrors pathCache's
    // "only cache a hit, keep retrying a miss" rule — the sidecar can briefly not
    // exist yet on the very first poll of a just-created file).
    if (fc.meta == null) fc.meta = readMeta(path.join(subagentsDir, `agent-${id}.meta.json`));
    const meta = fc.meta;
    const grew = fc.prevSize != null && fc.size > fc.prevSize;
    if (grew || fc.dangling) fc.quietPolls = 0;
    else fc.quietPolls = (fc.quietPolls || 0) + 1;
    list.push({
      id,
      agentType: meta?.agentType || 'agent',
      label: meta?.description || meta?.agentType || 'sub-agent',
      kind: 'background',
      status: grew || fc.dangling || fc.quietPolls < SUBAGENT_QUIET_POLLS ? 'running' : 'completed',
      startedAt: fc.startedAt,
      endedAt: fc.endedAt,
      usd: costUsd(fc.totals),
    });
  }
  return list;
}

// A single-line human summary of a tool call's main argument, from a small set of
// common input keys, with a generic fallback. Best-effort — never throws.
const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'url', 'query', 'prompt', 'description'];
function oneLine(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}
function toolTarget(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of TARGET_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return first ? oneLine(first) : '';
}

// message.content is a string OR an array of blocks — return its text either way.
function textOf(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    const t = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return t || null;
  }
  return null;
}

async function readLines(file) {
  const out = [];
  const raw = await fsp.readFile(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip non-JSON line */
    }
  }
  return out;
}

// On-demand, UNCACHED detail for one sub-agent (a fresh read on every click): its
// prompt → ordered tool calls → result. Background reads the agent file directly (the
// path is deterministic from the id); toolCalls is a real array, possibly []. Legacy
// re-scans the parent for the tool_use/tool_result pair; toolCalls is always null —
// that data never existed on disk, a different fact from "made zero calls" ([]).
export async function subagentDetail(sessionId, subagentId, projectsDir = PROJECTS_DIR) {
  const transcript = await findTranscript(sessionId, projectsDir);
  if (!transcript) return { prompt: null, toolCalls: null, result: null };
  const file = path.join(path.dirname(transcript), sessionId, 'subagents', `agent-${subagentId}.jsonl`);
  if (fs.existsSync(file)) {
    const entries = await readLines(file);
    let prompt = null;
    const toolCalls = [];
    let result = null;
    for (const e of entries) {
      const m = e.message;
      if (!m) continue;
      if (prompt == null && (e.type === 'user' || m.role === 'user')) {
        const t = textOf(m.content);
        if (t) prompt = t;
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === 'tool_use') toolCalls.push({ name: b.name || 'tool', target: toolTarget(b.input) });
        }
      }
      if (e.type === 'assistant' || m.role === 'assistant') {
        const t = textOf(m.content);
        if (t) result = t;
      }
    }
    return { prompt, toolCalls, result };
  }
  const entries = await readLines(transcript);
  let prompt = null;
  let result = null;
  for (const e of entries) {
    const m = e.message;
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === 'tool_use' && b.id === subagentId) prompt = (b.input && (b.input.prompt || b.input.description)) || null;
      if (b?.type === 'tool_result' && b.tool_use_id === subagentId) result = textOf(b.content);
    }
  }
  return { prompt, toolCalls: null, result };
}

// The usage bound for a mapping entry, as `analyze`/`analyzeLines` take it: a fork
// is billed only from its own launch, because `--fork-session` replays the parent's
// whole history into its transcript (see scanLine). Everything else is unbounded.
// Lives here — beside the bound it feeds — so state-reader and the devcontainer
// runtime can both reach it without either importing the other. A pre-split fork
// entry has no createdAt; unbounded keeps its (over-counted) old figure rather than
// silently zeroing the card. Resume is safe: plain `--resume` grows the transcript
// in place, and resumeEntry preserves both forkedFrom and createdAt.
export function usageSince(entry) {
  return entry?.forkedFrom && entry.createdAt ? entry.createdAt : 0;
}

// Incrementally analyse a session transcript for cost + sub-agents. `since` (epoch
// ms) excludes spend from before that instant — a fork's createdAt, so the parent
// history replayed into its transcript isn't billed twice (see scanLine).
export async function analyze(sessionId, projectsDir = PROJECTS_DIR, { since = 0 } = {}) {
  const transcript = await findTranscript(sessionId, projectsDir);
  if (!transcript) return { usd: null, subAgentUsd: 0, tokens: null, subAgents: [] };

  let state = cache.get(sessionId);
  // A changed bound invalidates the accumulated totals as surely as a changed file
  // does — the offset/totals were built under the old one.
  if (!state || state.transcript !== transcript || state.since !== since) {
    state = emptyState(transcript, since);
    cache.set(sessionId, state);
  }

  let stat;
  try {
    stat = await fsp.stat(transcript);
  } catch {
    return summarise(state);
  }

  // File truncated/rotated — restart.
  if (stat.size < state.offset) {
    state = emptyState(transcript, since);
    cache.set(sessionId, state);
  }

  if (stat.size > state.offset) {
    const stream = fs.createReadStream(transcript, {
      start: state.offset,
      end: stat.size - 1,
      encoding: 'utf8',
    });
    let buf = state.leftover;
    for await (const chunk of stream) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        scanLine(buf.slice(0, nl), state);
        buf = buf.slice(nl + 1);
      }
    }
    state.leftover = buf;
    state.offset = stat.size;
  }

  // Background wins when the subagents/ dir has files (the modern default); its
  // parent tool_use blocks are ignored to avoid double-counting. Else fall back to
  // the legacy pairs, inferring status from whether the tool_result landed. Either
  // way, accumulate the sub-agents' own spend into state.subAgentTotals so the
  // session total (summarise) reflects work done on this session's behalf.
  const subagentsDir = path.join(path.dirname(transcript), sessionId, 'subagents');
  const background = await subAgentsFrom(subagentsDir, state);
  state.subAgentTotals = {};
  if (background.length) {
    state.subAgents = background;
    // Cost each from its own transcript's per-turn totals — the same figures behind
    // the displayed per-agent usd — so the headline equals parent + the drill-down.
    for (const b of background) {
      const fc = state.subFiles.get(b.id);
      if (fc?.totals) mergeTotals(state.subAgentTotals, fc.totals);
    }
  } else {
    state.subAgents = [...state.legacyAgents.values()].map((a) => {
      const t = {};
      if (a.usage) addUsage(t, a.model, a.usage);
      mergeTotals(state.subAgentTotals, t);
      return {
        id: a.id,
        agentType: a.agentType,
        label: a.label,
        kind: 'legacy',
        status: a.endedAt == null ? 'running' : 'completed',
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        usd: a.usage ? costUsd(t) : null,
      };
    });
  }

  return summarise(state);
}

function summarise(state) {
  // The session total is the parent's own turns PLUS its sub-agents' spend; both
  // tokens and usd cover the combined set, with subAgentUsd the sub-agent portion.
  const sub = state.subAgentTotals || {};
  const combined = {};
  mergeTotals(combined, state.totals);
  mergeTotals(combined, sub);
  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  for (const t of Object.values(combined)) {
    input += t.input;
    output += t.output;
    cacheWrite += t.cacheWrite5m + t.cacheWrite1h;
    cacheRead += t.cacheRead;
  }
  return {
    usd: costUsd(combined),
    subAgentUsd: costUsd(sub),
    tokens: { input, output, cacheWrite, cacheRead },
    subAgents: state.subAgents,
    lastActivity: state.lastActivity || null,
    summary: state.summary || null,
    aiTitle: state.aiTitle || null,
    apiError: Boolean(state.apiError),
  };
}
