// Pure transcript-line → normalised chat event. Deliberately mirrors
// server/search/extract.js's shape (per-agent extractor, cheap substring gate
// before JSON.parse, doc-meta merged as seen) but KEEPS the tool calls that
// extract.js drops on purpose — the two modules have opposite goals and must not
// be merged.
//
// A LEAF: no imports from session-manager / state-reader / tmux-scraper / index.
// Consequence: it unit-tests from a jsonl string with no server and no DOM.

// Tool input/output is capped because a single Read of a large file, or an
// `npm test` dump, arrives as one tool_result. Without the cap one file read
// pushes a multi-megabyte frame over the control socket every poll.
export const MAX_TOOL_TEXT = 2000;

const SYNTHETIC_PREFIXES = ['<environment_context>', '<user_instructions>', '<environment_details>'];
function isSynthetic(text) {
  const head = text.slice(0, 40).trimStart();
  return SYNTHETIC_PREFIXES.some((p) => head.startsWith(p));
}

// Same key list transcript-reader.js uses for a tool's one-line target, so the
// chat view and the sub-agent modal name a call the same way.
const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'url', 'query', 'prompt', 'description'];

function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim();
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

function cap(text) {
  const s = typeof text === 'string' ? text : textOf(text);
  if (s.length <= MAX_TOOL_TEXT) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_TOOL_TEXT), truncated: true };
}

// Write's `content` and Edit's `old_string`/`new_string` can each carry a whole
// file, so input needs the same bound as output. Copies rather than mutates —
// the pending entry stays uncapped because a later task derives adds/dels from
// the real (uncapped) input.
function capInput(input) {
  if (!input || typeof input !== 'object') return { input, truncated: false };
  let truncated = false;
  const capped = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > MAX_TOOL_TEXT) {
      capped[k] = v.slice(0, MAX_TOOL_TEXT);
      truncated = true;
    } else {
      capped[k] = v;
    }
  }
  return { input: capped, truncated };
}

function tsOf(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// The cheap gate: one indexOf over the raw line is ~100x cheaper than parsing it
// to discover the line can't contribute.
export function mightCarryChat(line, agent) {
  if (agent === 'codex') return line.includes('"type":"message"') || line.includes('"function_call') || line.includes('"reasoning"');
  return line.includes('"role":"user"') || line.includes('"role":"assistant"');
}

function pushClaude(entry, state) {
  const out = [];
  const msg = entry.message;
  if (!msg || typeof msg !== 'object' || entry.isMeta) return out;
  const ts = tsOf(entry.timestamp);
  if (msg.role === 'user') {
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type !== 'tool_result') continue;
        const open = state.pending.get(b.tool_use_id);
        if (!open) continue;
        state.pending.delete(b.tool_use_id);
        const { text: output, truncated: outputTruncated } = cap(b.content);
        const { input, truncated: inputTruncated } = capInput(open.input);
        out.push({
          kind: 'tool', id: open.id, name: open.name, target: open.target,
          input, output, ok: b.is_error !== true, ts, truncated: outputTruncated || inputTruncated,
        });
      }
    }
    const text = textOf(msg.content);
    if (text && !isSynthetic(text)) out.push({ kind: 'user', text, ts });
    return out;
  }
  if (msg.role !== 'assistant') return out;
  if (msg.model) state.model = msg.model;
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        out.push({ kind: 'thinking', ts, text: b.thinking.trim() });
      }
      if (b?.type === 'tool_use' && b.id) {
        state.pending.set(b.id, { id: b.id, name: b.name || 'tool', target: toolTarget(b.input), input: b.input ?? null });
      }
    }
  }
  const text = textOf(msg.content);
  if (text) out.push({ kind: 'assistant', text, ts, model: msg.model || state.model || null });
  return out;
}

export function createChatScanner(agent = 'claude') {
  const state = { agent, model: null, pending: new Map() };
  return {
    push(line) {
      if (!line || !line.trim()) return [];
      if (!mightCarryChat(line, agent)) return [];
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return []; // a half-written trailing line is normal for a live session
      }
      return pushClaude(entry, state);
    },
    pending() {
      const last = [...state.pending.values()].pop();
      return last ? { name: last.name, target: last.target } : null;
    },
  };
}

export function scanChatText(text, agent = 'claude') {
  const scanner = createChatScanner(agent);
  const events = [];
  for (const line of text.split('\n')) events.push(...scanner.push(line));
  return { events, pending: scanner.pending() };
}
