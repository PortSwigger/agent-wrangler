import { MAX_TOOL_TEXT } from './chat-scanner.js';
import { ROLE_USER, ROLE_ASSISTANT } from '../search/records.js';

// Reading a Gemini CLI conversation (gemini-files.js has the on-disk layout).
// Its JSONL is a log of edits to a message list rather than a list of
// messages: a record is re-appended under the same id each time Gemini adds
// tokens or tool calls to it, `$rewindTo` drops a message and everything after
// it (Gemini also does this to the prompt of a turn that failed), `$patch`
// removes or edits messages and a `$set` carrying `messages` replaces them all.
// The chat view, search and usage below each read it with that in mind.

// The text of a message's content: a bare string or a Gemini part list.
export function geminiText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
}

// Context Gemini or a hook injected as a user turn: never typed by the human.
export function isSyntheticGeminiUser(text) {
  const t = String(text || '').trimStart();
  return t.startsWith('<session_context>') || t.startsWith('<hook_context>');
}

const TERMINAL_TOOL_STATUS = new Set(['success', 'error', 'cancelled']);

// The one-line target the chat view shows beside a tool name.
const TARGET_KEYS = ['command', 'file_path', 'absolute_path', 'dir_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description'];
function toolTarget(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of TARGET_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim();
  }
  return '';
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
    if (typeof v === 'string' && v.length > MAX_TOOL_TEXT) {
      input[k] = v.slice(0, MAX_TOOL_TEXT);
      truncated = true;
    } else input[k] = v;
  }
  return { input, truncated };
}

// A tool call's output as text: its display form when it has one, else the
// function responses Gemini sent back to the model.
function toolOutput(call) {
  if (typeof call.resultDisplay === 'string') return call.resultDisplay;
  const parts = Array.isArray(call.result) ? call.result : [];
  const texts = parts.map((p) => {
    const r = p?.functionResponse?.response;
    if (!r) return typeof p?.text === 'string' ? p.text : '';
    if (typeof r.output === 'string') return r.output;
    if (typeof r.error === 'string') return r.error;
    return JSON.stringify(r);
  }).filter(Boolean);
  return texts.join('\n');
}

const tsOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

// The cheap gate before JSON.parse: only these lines can change what the chat shows.
export function mightCarryGeminiChat(line) {
  return line.includes('"type":"user"') || line.includes('"type":"gemini"') || line.includes('"type":"error"')
    || line.includes('"$rewindTo"') || line.includes('"$patch"') || line.includes('"messages"');
}

// The chat scanner the chat view and last-assistant read (same contract as
// createNativeChatScanner): the scanner remembers which message each event came
// from, so a rewind prunes it from a full rebuild, and each piece of a message (its
// text, each thought, each finished tool call) is emitted once however many
// times the message is re-appended.
export function createGeminiChatScanner() {
  const state = {
    order: [], // message ids in conversation order
    known: new Set(), // the same ids, for lookups
    emittedText: new Set(),
    thoughtsSeen: new Map(), // id → thoughts emitted
    toolsDone: new Set(),
    pending: new Map(), // tool call id → { name, target }
    removed: new Set(),
    emitted: new Set(), // ids that produced at least one event
    model: null,
    prevTs: null,
    rewound: false,
    pendingRewind: null, // ids a `$rewindTo` drops unless an error follows
  };
  const owner = new WeakMap(); // event → the message id it came from

  function tag(id, events) {
    for (const e of events) owner.set(e, id);
    if (events.length) state.emitted.add(id);
    return events;
  }

  function remove(ids) {
    for (const id of ids) {
      state.removed.add(id);
      if (state.emitted.has(id)) state.rewound = true;
    }
    state.order = state.order.filter((id) => !state.removed.has(id));
    state.known = new Set(state.order);
  }

  function pushMessage(m) {
    const out = [];
    if (!m || typeof m.id !== 'string') return out;
    if (!state.known.has(m.id)) { state.order.push(m.id); state.known.add(m.id); }
    state.removed.delete(m.id);
    const ts = tsOf(m.timestamp);
    if (m.type === 'user') {
      if (state.emittedText.has(m.id)) return out;
      const text = geminiText(m.content).trim();
      if (!text || isSyntheticGeminiUser(text)) return out;
      state.emittedText.add(m.id);
      out.push({ kind: 'user', text, ts });
      state.prevTs = ts;
      return out;
    }
    if (m.type === 'error') {
      if (state.emittedText.has(m.id)) return out;
      state.emittedText.add(m.id);
      const text = geminiText(m.content).trim();
      if (text) out.push({ kind: 'context', label: 'Gemini error', text, ts });
      return out;
    }
    if (m.type !== 'gemini') return out;
    if (typeof m.model === 'string' && m.model) state.model = m.model;
    const thoughts = Array.isArray(m.thoughts) ? m.thoughts : [];
    for (let i = state.thoughtsSeen.get(m.id) || 0; i < thoughts.length; i += 1) {
      const t = thoughts[i] || {};
      const at = tsOf(t.timestamp) || ts;
      const think = { kind: 'thinking', ts: at };
      if (state.prevTs && at > state.prevTs) think.durationMs = at - state.prevTs;
      const text = [t.subject, t.description].filter((s) => typeof s === 'string' && s.trim()).join(': ').trim();
      if (text) think.text = text;
      out.push(think);
      state.prevTs = at;
    }
    state.thoughtsSeen.set(m.id, thoughts.length);
    const text = geminiText(m.content).trim();
    if (text && !state.emittedText.has(m.id)) {
      state.emittedText.add(m.id);
      out.push({ kind: 'assistant', text, ts, model: m.model || state.model || null });
      state.prevTs = ts;
    }
    for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      if (!call?.id || state.toolsDone.has(call.id)) continue;
      const target = toolTarget(call.args);
      if (!TERMINAL_TOOL_STATUS.has(call.status)) {
        state.pending.set(call.id, { name: call.name, target });
        continue;
      }
      state.pending.delete(call.id);
      state.toolsDone.add(call.id);
      const { input, truncated: inTrunc } = capArgs(call.args);
      const { text: output, truncated: outTrunc } = capText(toolOutput(call));
      const at = tsOf(call.timestamp) || ts;
      out.push({ kind: 'tool', id: call.id, name: call.displayName || call.name, target, input, output, ok: call.status === 'success', ts: at, truncated: inTrunc || outTrunc });
      state.prevTs = at;
    }
    return out;
  }

  function pushTagged(line) {
    if (!line || !line.trim() || !mightCarryGeminiChat(line)) return { uuid: null, events: [] };
    let rec;
    try { rec = JSON.parse(line); } catch { return { uuid: null, events: [] }; }
    if (!rec || typeof rec !== 'object') return { uuid: null, events: [] };
    if (typeof rec.$rewindTo === 'string') {
      // Applied at the next record: Gemini also rewinds the prompt of a turn
      // that failed, and that prompt stays in the chat beside its error.
      const at = state.order.indexOf(rec.$rewindTo);
      state.pendingRewind = at === -1 ? [...state.order] : state.order.slice(at);
      return { uuid: null, events: [] };
    }
    if (state.pendingRewind) {
      const failedTurn = rec.type === 'error' || (rec.$set && !Array.isArray(rec.$set.messages));
      if (!failedTurn || rec.type === 'error') {
        if (!failedTurn) remove(state.pendingRewind);
        state.pendingRewind = null;
      }
    }
    if (rec.$patch && typeof rec.$patch === 'object') {
      const ids = Array.isArray(rec.$patch.removeIds) ? rec.$patch.removeIds.filter((id) => typeof id === 'string') : [];
      if (ids.length) remove(ids);
      return { uuid: null, events: [] };
    }
    if (rec.$set && typeof rec.$set === 'object') {
      if (!Array.isArray(rec.$set.messages)) return { uuid: null, events: [] };
      const keep = new Set(rec.$set.messages.map((m) => m?.id).filter(Boolean));
      remove(state.order.filter((id) => !keep.has(id)));
      return { uuid: null, events: rec.$set.messages.flatMap((m) => tag(m?.id, pushMessage(m))) };
    }
    const events = tag(rec.id, pushMessage(rec));
    return { uuid: typeof rec.id === 'string' ? rec.id : null, events };
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
    // Drops events of messages a later rewind or patch removed.
    selectLive(tagged) {
      return tagged.flatMap((t) => t.events.filter((e) => !state.removed.has(owner.get(e) ?? t.uuid)));
    },
    lastTs: () => state.prevTs ?? null,
  };
}

// ---- Search -----------------------------------------------------------------

export function mightCarryGeminiText(line) {
  return line.includes('"type":"user"') || line.includes('"type":"gemini"') || line.includes('"sessionId"');
}

// One line → a search record. A Gemini message is re-appended as it grows, so
// its text is indexed from one copy only: the copy that carries its tokens and
// no tool calls (tool calls only ever arrive after the text; a message that
// gets tokens later is first written without them).
export function extractGeminiLine(line) {
  if (!line || !mightCarryGeminiText(line)) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  const meta = {};
  if (rec && typeof rec.sessionId === 'string' && rec.projectHash) {
    meta.id = rec.sessionId;
    return { meta };
  }
  if (!rec || typeof rec.id !== 'string') return { meta };
  const text = geminiText(rec.content).trim();
  if (!text) return { meta };
  const tsSec = Math.floor(tsOf(rec.timestamp) / 1000);
  if (rec.type === 'user') return isSyntheticGeminiUser(text) ? { meta } : { meta, record: { role: ROLE_USER, text, tsSec } };
  if (rec.type === 'gemini' && rec.tokens && !rec.toolCalls?.length) return { meta, record: { role: ROLE_ASSISTANT, text, tsSec } };
  return { meta };
}

// ---- Usage ------------------------------------------------------------------

// Every billed model response in a conversation, once each (the last copy of a
// re-appended message carries its final tokens). Rewound messages still count:
// their tokens were spent. `since` (ms) drops responses before a fork point.
export function collectResponses(lines, { since = 0 } = {}) {
  const byId = new Map();
  let head = null;
  let summary = null;
  let lastActivity = null;
  let firstPrompt = null;
  const consider = (m) => {
    if (!m || typeof m.id !== 'string') return;
    const ts = tsOf(m.timestamp);
    if (ts && (lastActivity == null || ts > lastActivity)) lastActivity = ts;
    if (m.type === 'user' && firstPrompt == null) {
      const text = geminiText(m.content).trim();
      if (text && !isSyntheticGeminiUser(text)) firstPrompt = text;
    }
    if (m.type === 'gemini' && m.tokens && typeof m.tokens === 'object') byId.set(m.id, { ts, model: m.model || null, tokens: m.tokens });
  };
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (head == null && typeof rec.sessionId === 'string') { head = rec; continue; }
    if (rec.$set && typeof rec.$set === 'object') {
      if (typeof rec.$set.summary === 'string') summary = rec.$set.summary;
      if (Array.isArray(rec.$set.messages)) rec.$set.messages.forEach(consider);
      continue;
    }
    consider(rec);
  }
  const floor = Math.max(since || 0, Date.parse(head?.forkedAt || '') || 0);
  const responses = [...byId.values()].filter((r) => !floor || r.ts >= floor);
  return { head, responses, summary: summary || firstPrompt, lastActivity };
}

// A response's tokens in the shape the price catalog bills: Gemini's `input`
// includes the cached part and `thoughts` bill as output; tool-use prompt
// tokens bill as input. `long` holds the same tokens again when the prompt
// crossed the long-context threshold (pricing.js geminiCostUsd).
export function billedTokens(t = {}) {
  const cached = Number(t.cached) || 0;
  const prompt = (Number(t.input) || 0) + (Number(t.tool) || 0);
  return {
    input: Math.max(0, prompt - cached),
    output: (Number(t.output) || 0) + (Number(t.thoughts) || 0),
    cacheRead: cached,
    prompt,
  };
}
