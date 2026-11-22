import { MAX_TOOL_TEXT } from './chat-scanner.js';
import { ROLE_USER, ROLE_ASSISTANT } from '../search/records.js';

// Reading an agy conversation's JSONL mirror (agy-db.js writes it): a head line
// ({ agy, conversationId, cwd, … }), then one record per settled step keyed by
// `idx` (re-appended when a step changes; the last copy wins) and `rewindTo`
// records dropping every step from that index on. The chat view, search and
// usage below each read it that way.

const TARGET_KEYS = ['CommandLine', 'command', 'AbsolutePath', 'Path', 'path', 'file_path', 'TargetFile', 'DirectoryPath', 'SearchPath', 'Query', 'query', 'Url', 'url', 'prompt', 'description'];

function toolTarget(args) {
  if (!args || typeof args !== 'object') return typeof args === 'string' ? args.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  for (const k of TARGET_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim();
  }
  const first = Object.values(args).find((v) => typeof v === 'string' && v.trim());
  return first ? first.replace(/\s+/g, ' ').trim() : '';
}

function capText(s) {
  const text = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s);
  return text.length > MAX_TOOL_TEXT ? { text: text.slice(0, MAX_TOOL_TEXT), truncated: true } : { text, truncated: false };
}

function capArgs(args) {
  if (!args || typeof args !== 'object') return { input: args ?? null, truncated: false };
  let truncated = false;
  const input = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > MAX_TOOL_TEXT) { input[k] = v.slice(0, MAX_TOOL_TEXT); truncated = true; } else input[k] = v;
  }
  return { input, truncated };
}

function parse(line) {
  if (!line || !line.trim()) return null;
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

export const mightCarryAgyChat = (line) => line.includes('"kind"') || line.includes('"rewindTo"');

// The chat scanner (same contract as createNativeChatScanner): each step's
// events are emitted once however often it is re-appended, and a rewind prunes
// them from a full rebuild.
export function createAgyChatScanner() {
  const state = {
    emitted: new Set(), // idx that produced events
    seen: new Set(), // idx already handled
    removed: new Set(),
    pending: new Map(), // tool call id → { name, target }
    prevTs: null,
    rewound: false,
    model: null,
  };
  const owner = new WeakMap();

  function eventsFor(rec) {
    const out = [];
    const ts = Number(rec.ts) || 0;
    if (rec.kind === 'user') {
      const text = String(rec.text || '').trim();
      if (text) out.push({ kind: 'user', text, ts });
    } else if (rec.kind === 'assistant') {
      if (rec.model) state.model = rec.model;
      if (rec.thinking) {
        const think = { kind: 'thinking', ts, text: String(rec.thinking).trim() };
        if (state.prevTs && ts > state.prevTs) think.durationMs = ts - state.prevTs;
        out.push(think);
      }
      const text = String(rec.text || '').trim();
      if (text) out.push({ kind: 'assistant', text, ts, model: rec.model || state.model || null });
      for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
        if (call?.id) state.pending.set(call.id, { name: call.name, target: toolTarget(call.args) });
      }
    } else if (rec.kind === 'tool') {
      state.pending.delete(rec.id);
      const { input, truncated: inTrunc } = capArgs(rec.args);
      const { text: output, truncated: outTrunc } = capText(rec.output);
      out.push({ kind: 'tool', id: rec.id || `step-${rec.idx}`, name: rec.name || 'tool', target: toolTarget(rec.args), input, output, ok: rec.ok !== false, ts, truncated: inTrunc || outTrunc });
    } else if (rec.kind === 'error') {
      const text = String(rec.text || '').trim();
      if (text) out.push({ kind: 'context', label: 'agy error', text, ts });
    }
    if (out.length) state.prevTs = ts;
    return out;
  }

  function pushTagged(line) {
    if (!line || !mightCarryAgyChat(line)) return { uuid: null, events: [] };
    const rec = parse(line);
    if (!rec) return { uuid: null, events: [] };
    if (typeof rec.rewindTo === 'number') {
      for (const idx of state.seen) {
        if (idx < rec.rewindTo) continue;
        state.removed.add(idx);
        state.seen.delete(idx);
        if (state.emitted.has(idx)) state.rewound = true;
      }
      return { uuid: null, events: [] };
    }
    if (typeof rec.idx !== 'number' || state.seen.has(rec.idx)) return { uuid: null, events: [] };
    state.seen.add(rec.idx);
    state.removed.delete(rec.idx);
    const events = eventsFor(rec);
    for (const e of events) owner.set(e, rec.idx);
    if (events.length) state.emitted.add(rec.idx);
    return { uuid: String(rec.idx), events };
  }

  return {
    pushTagged,
    push: (line) => pushTagged(line).events,
    pending() {
      const last = [...state.pending.values()].pop();
      return last ? { name: last.name, target: last.target } : null;
    },
    takeRewound() {
      const was = state.rewound;
      state.rewound = false;
      return was;
    },
    selectLive(tagged) {
      return tagged.flatMap((t) => t.events.filter((e) => !state.removed.has(owner.get(e))));
    },
    lastTs: () => state.prevTs ?? null,
  };
}

// ---- Search -----------------------------------------------------------------

export const mightCarryAgyText = (line) => line.includes('"kind":"user"') || line.includes('"kind":"assistant"') || line.includes('"conversationId"');

export function extractAgyLine(line) {
  if (!line || !mightCarryAgyText(line)) return null;
  const rec = parse(line);
  if (!rec) return null;
  const meta = {};
  if (typeof rec.conversationId === 'string' && rec.agy) {
    meta.id = rec.conversationId;
    if (typeof rec.cwd === 'string' && rec.cwd) meta.cwd = rec.cwd;
    return { meta };
  }
  const text = String(rec.text || '').trim();
  if (!text) return { meta };
  const tsSec = Math.floor((Number(rec.ts) || 0) / 1000);
  if (rec.kind === 'user') return { meta, record: { role: ROLE_USER, text, tsSec } };
  if (rec.kind === 'assistant') return { meta, record: { role: ROLE_ASSISTANT, text, tsSec } };
  return { meta };
}

// ---- Usage ------------------------------------------------------------------

// Every billed model reply, once each (the last copy of a re-appended step
// wins). Rewound replies still count: their tokens were spent. `since` (ms)
// drops replies before it.
export function collectResponses(lines, { since = 0 } = {}) {
  const byIdx = new Map();
  let head = null;
  let firstPrompt = null;
  let lastActivity = null;
  for (const line of lines) {
    const rec = parse(line);
    if (!rec) continue;
    if (!head && rec.agy) { head = rec; continue; }
    const ts = Number(rec.ts) || 0;
    if (ts && (lastActivity == null || ts > lastActivity)) lastActivity = ts;
    if (rec.kind === 'user' && firstPrompt == null && String(rec.text || '').trim()) firstPrompt = String(rec.text).trim();
    if (rec.kind === 'assistant' && rec.usage) byIdx.set(rec.idx, { ts, model: rec.model || null, usage: rec.usage });
  }
  const responses = [...byIdx.values()].filter((r) => !since || r.ts >= since);
  return { head, responses, summary: firstPrompt, lastActivity };
}

// A reply's tokens as billed: `output` already includes the thinking tokens.
export function billedTokens(u = {}) {
  const input = Number(u.input) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  return { input, output: Number(u.output) || 0, cacheRead, prompt: input + cacheRead };
}
