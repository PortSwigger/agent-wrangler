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

// Task/Agent tool_use blocks mark a sub-agent's spawn point only — the client
// reads status/cost off the graph's existing s.subAgents, so this must not
// re-derive the subagents/-dir-vs-inline discriminator that transcript-reader.js
// owns (duplicating it is what makes sub-agents double-count).
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

// Phrasing each agent's tool_result uses when a permission prompt is denied —
// this is the only place a resolved denial is visible after the fact.
const DENIED_MARKERS = ["user doesn't want to proceed", 'user rejected', 'user denied'];

function noticeFor(open, resultText) {
  const low = resultText.toLowerCase();
  if (DENIED_MARKERS.some((m) => low.includes(m))) {
    return { kind: 'notice', noticeKind: 'denied', text: open.target || open.name };
  }
  return null;
}

// Line counts for the `+N −M` on an edit activity chip. Deliberately approximate for
// Edit/Write — the tool input is all we have, so a replacement whose old_string spans
// unchanged context over-counts. The diff panel stays the authority; this is a hint.
// apply_patch is the exception: its input IS a patch, so its +/- lines are exact.
const EDIT_COUNT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch']);

function lineCount(s) {
  return typeof s === 'string' && s ? s.split('\n').length : 0;
}

function editCounts(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (name === 'apply_patch') {
    const body = typeof input.patch === 'string' ? input.patch : typeof input.input === 'string' ? input.input : '';
    let adds = 0;
    let dels = 0;
    for (const line of body.split('\n')) {
      // Skip the +++/--- file headers; only the hunk body's own markers count.
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) adds += 1;
      else if (line.startsWith('-')) dels += 1;
    }
    return { adds, dels };
  }
  const added = input.new_string ?? input.content ?? input.new_source;
  const removed = input.old_string;
  return { adds: lineCount(added), dels: lineCount(removed) };
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
  if (agent === 'codex') {
    return line.includes('"type":"message"') || line.includes('"function_call')
      || line.includes('"reasoning"') || line.includes('"tool_search')
      || line.includes('"turn_context"');
  }
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
        // Derived from open.input (uncapped, still in `pending` at this point) —
        // never from the just-capped copy above, or a large Write undercounts.
        const counts = EDIT_COUNT_TOOLS.has(open.name) ? editCounts(open.name, open.input) : null;
        out.push({
          kind: 'tool', id: open.id, name: open.name, target: open.target,
          input, output, ok: b.is_error !== true, ts, truncated: outputTruncated || inputTruncated,
          ...(counts || {}),
        });
        // Gate on is_error first: two of the three markers ('user rejected',
        // 'user denied') are generic enough to appear in ordinary successful
        // output (e.g. an auth log line), so the phrase alone isn't enough —
        // a spurious denial notice needs both an error result AND the phrase.
        const notice = b.is_error === true ? noticeFor(open, output) : null;
        if (notice) out.push({ ...notice, ts });
      }
    }
    const text = textOf(msg.content);
    if (text && !isSynthetic(text)) out.push({ kind: 'user', text, ts });
    state.prevTs = ts;
    return out;
  }
  if (msg.role !== 'assistant') return out;
  if (msg.model) state.model = msg.model;
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b?.type === 'thinking') {
        const think = { kind: 'thinking', ts };
        if (state.prevTs && ts > state.prevTs) think.durationMs = ts - state.prevTs;
        // Blank `thinking` is the norm, not an anomaly: Claude redacts the real
        // content into `b.signature` (an opaque blob), so an empty string here
        // means "thinking happened, content unavailable" — the exact analogue
        // of Codex's encrypted `reasoning` line. Do not gate emission on
        // non-empty text, or most real Claude sessions show no thinking
        // indicator at all while Codex ones still would.
        if (typeof b.thinking === 'string' && b.thinking.trim()) think.text = b.thinking.trim();
        out.push(think);
      }
      if (b?.type === 'tool_use' && b.id && SUBAGENT_TOOLS.has(b.name)) {
        const name = b.input?.description || b.input?.subagent_type || b.name;
        out.push({ kind: 'subagent', id: b.id, name: oneLine(String(name)), ts });
        continue;
      }
      if (b?.type === 'tool_use' && b.id) {
        state.pending.set(b.id, { id: b.id, name: b.name || 'tool', target: toolTarget(b.input), input: b.input ?? null });
      }
    }
  }
  const text = textOf(msg.content);
  if (text) out.push({ kind: 'assistant', text, ts, model: msg.model || state.model || null });
  state.prevTs = ts;
  return out;
}

function codexText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && ['input_text', 'output_text', 'text'].includes(b.type) && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Codex tool arguments arrive as a JSON *string*, unlike Claude's object.
function codexArgs(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : null;
  try {
    return JSON.parse(raw);
  } catch {
    return { command: oneLine(raw) };
  }
}

function pushCodex(entry, state) {
  const out = [];
  const p = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
  // Codex names its model once per turn on its own line, not on the message lines —
  // so an assistant event's model comes from carried state, never from the message.
  if (entry.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) state.model = p.model;
    return out;
  }
  // event_msg/agent_message and user_message repeat response_item/message
  // verbatim; indexing only response_item keeps every message exactly once.
  if (entry.type !== 'response_item') return out;
  const ts = tsOf(entry.timestamp);

  if (p.type === 'message') {
    // `developer` carries injected permissions/instructions text, not conversation.
    const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null;
    if (!role) return out;
    const text = codexText(p.content);
    if (!text) return out;
    if (role === 'user' && isSynthetic(text)) return out;
    if (role === 'user') out.push({ kind: 'user', text, ts });
    else out.push({ kind: 'assistant', text, ts, model: state.model || null });
    state.prevTs = ts;
    return out;
  }

  // summary is always [] and the content is encrypted — presence only, never text.
  if (p.type === 'reasoning') {
    const think = { kind: 'thinking', ts };
    if (state.prevTs && ts > state.prevTs) think.durationMs = ts - state.prevTs;
    out.push(think);
    state.prevTs = ts;
    return out;
  }

  if (p.type === 'function_call' || p.type === 'tool_search_call') {
    // BOTH ids exist: `id` is fc_…/tsc_…, `call_id` is call_…. The output only
    // ever carries call_id, so keying on `id` silently orphans every result.
    if (!p.call_id) return out;
    const input = codexArgs(p.arguments);
    state.pending.set(p.call_id, {
      id: p.call_id, name: p.name || p.type, target: toolTarget(input), input,
    });
    state.prevTs = ts;
    return out;
  }

  if (p.type === 'function_call_output' || p.type === 'tool_search_output') {
    const open = state.pending.get(p.call_id);
    if (!open) return out;
    state.pending.delete(p.call_id);
    const { text: output, truncated: outputTruncated } = cap(typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''));
    // Cap a COPY at emission — apply_patch embeds a full diff body, so this
    // needs the same bound as Claude's Write/Edit input. The uncapped original
    // stays in `open.input`/`state.pending` because a later task derives
    // apply_patch +/- line counts from the real (uncapped) patch text.
    const { input, truncated: inputTruncated } = capInput(open.input);
    // Derived from open.input (uncapped) for the same reason as the Claude side —
    // apply_patch's patch body would otherwise be cut to MAX_TOOL_TEXT first.
    const counts = EDIT_COUNT_TOOLS.has(open.name) ? editCounts(open.name, open.input) : null;
    // function_call_output carries no structured error flag, only free text
    // ("Process exited with code N") — `ok` can't be derived, so it's always true.
    out.push({
      kind: 'tool', id: open.id, name: open.name, target: open.target, input, output, ok: true, ts, truncated: outputTruncated || inputTruncated,
      ...(counts || {}),
    });
    state.prevTs = ts;
    return out;
  }
  state.prevTs = ts;
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
      return agent === 'codex' ? pushCodex(entry, state) : pushClaude(entry, state);
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
