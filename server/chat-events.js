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
    }
  }
  const text = textOf(msg.content);
  if (text) out.push({ kind: 'assistant', text, ts, model: msg.model || state.model || null });
  return out;
}

export function createChatScanner(agent = 'claude') {
  const state = { agent, model: null };
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
    pending: () => null,
  };
}

export function scanChatText(text, agent = 'claude') {
  const scanner = createChatScanner(agent);
  const events = [];
  for (const line of text.split('\n')) events.push(...scanner.push(line));
  return { events, pending: scanner.pending() };
}
