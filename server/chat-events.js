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

// Wrappers Claude Code writes as ordinary user messages that are not things a
// human said. The command trio is the plumbing of a slash command: the
// invocation (`<command-name>/model…`), whatever it printed
// (`<local-command-stdout>`, `…-stderr`) and the caveat line. Slash commands
// belong to the pane by design, so their internals have no business rendering
// as chat — and they arrive as raw tag soup, which is what they looked like.
// (`<local-command-caveat>` also carries isMeta, so it is already dropped a few
// lines below; it is listed here so the set reads as one idea rather than
// depending on a second mechanism to be complete.)
const SYNTHETIC_PREFIXES = [
  '<environment_context>', '<user_instructions>', '<environment_details>',
  '<command-name>', '<command-message>', '<command-args>',
  '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>',
];
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

// The pending map is deliberately persistent across polls (see createChatScanner)
// so a tool_use in one window pairs with a tool_result arriving in a later one —
// but a call whose result never arrives (pane killed or suspended mid-tool, or
// interrupted by the chat view's own Stop button) is orphaned forever, and
// without a cap it sits in the map for the scanner's whole cached lifetime.
// Worse, an orphaned Write/apply_patch entry pins its UNCAPPED input (capInput
// only copies a bounded slice at emission time) — that's the one genuinely
// unbounded dimension of this otherwise-bounded cache. A real in-flight set is
// one or two calls; 32 is generous headroom above that while still bounding the
// worst case an orphan can pin.
// Claude Code's end-of-turn recap (`type:'system'`, `subtype:'away_summary'`) —
// a summary of where the conversation is plus, usually, a proposed next step.
// The terminal renders it as "※ recap: …"; the stored `content` has neither that
// prefix nor any structure, so the split is textual.
//
// Two things are stripped or separated:
//  - The trailing "(disable recaps in /config)" is TUI chrome. It instructs the
//    reader to type a slash command, which the chat view has no way to accept
//    (slash commands stay in the pane by design), so repeating it here would be
//    an instruction the surface cannot honour.
//  - The "Next:" / "Next action:" sentence is pulled out as `next` so the view
//    can offer it as a prompt rather than as more prose. Split on the LAST such
//    marker: the summary half is free text that may well contain the word
//    itself ("...decided what to do next: ship it"), and the real marker is the
//    one that starts the final sentence.
const RECAP_CHROME = /\s*\(disable recaps in \/config\)\s*$/;
const RECAP_NEXT = /\bNext(?: action)?:\s*/g;

export function recapOf(content) {
  if (typeof content !== 'string') return null;
  const body = content.replace(RECAP_CHROME, '').trim();
  if (!body) return null;
  const marks = [...body.matchAll(RECAP_NEXT)];
  const last = marks[marks.length - 1];
  // Only treat it as a next-step when something actually follows the marker;
  // a recap ending on a bare "Next:" would otherwise yield an empty prompt.
  if (last) {
    const summary = body.slice(0, last.index).trim();
    const next = body.slice(last.index + last[0].length).trim();
    if (next) return { kind: 'recap', text: summary, next };
  }
  return { kind: 'recap', text: body, next: null };
}

const MAX_PENDING = 32;

function setPending(pending, id, entry) {
  pending.set(id, entry);
  if (pending.size > MAX_PENDING) {
    pending.delete(pending.keys().next().value); // oldest-out, same idiom as the scanner LRU cache
  }
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

// Claude Code emits an attached image as THREE things in one user message: the
// prose (with a `[Image #1]` marker where the path used to be), a real base64
// `image` block, and a trailing text block reading `[Image: source: <abs path>]`.
// Verified against a live transcript, exact format included.
//
// The source block is plumbing and must not reach the reader: it is an absolute
// local path they cannot act on, and it is long enough to bury the actual prompt.
// The `[Image #1]` marker in the prose DOES stay — it is what the pane shows, and
// the prose can refer to it ("compare [Image #1] with…"), so stripping it would
// break a sentence to save nothing.
const IMAGE_SOURCE_RE = /^\[Image: source: (.+)\]$/;

// Paired by ORDER, not by id: an `image` block carries only its base64, so there
// is no key linking it to its source line. Counting them separately and zipping
// is therefore the most the transcript supports — an image whose source block is
// missing still gets a chip, just an unnamed one, which is the honest outcome.
function userTextAndImages(content) {
  if (typeof content === 'string') return { text: content.trim(), images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const parts = [];
  const sources = [];
  let imageCount = 0;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'image') { imageCount += 1; continue; }
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    const src = IMAGE_SOURCE_RE.exec(b.text.trim());
    if (src) sources.push(src[1]);
    else parts.push(b.text);
  }
  // A source block with no image block still counts: it is evidence an image was
  // attached, and dropping it would silently under-report the message.
  const total = Math.max(imageCount, sources.length);
  const text = parts.join('\n').trim();
  // The label comes from the marker IN THE PROSE, not from counting up from one.
  // Claude Code numbers attachments cumulatively per session, so a message's
  // second-ever image is `[Image #10]` — labelling its chip "Image #2" would
  // disagree with the text right beside it and with the pane. Verified against a
  // live session that produced `[Image #9] [Image #10]`. Positional fallback only
  // when the prose carries no marker at all.
  const marked = [...text.matchAll(/\[Image #(\d+)\]/g)].map((m) => m[1]);
  const images = [];
  for (let i = 0; i < total; i += 1) {
    const src = sources[i];
    // basename by hand rather than node:path — this module is a leaf that also
    // has to stay trivially testable, and one split is cheaper than the import.
    images.push({ label: `Image #${marked[i] ?? i + 1}`, name: src ? src.split('/').pop() : '' });
  }
  return { text, images };
}

// The cheap gate: one indexOf over the raw line is ~100x cheaper than parsing it
// to discover the line can't contribute.
export function mightCarryChat(line, agent) {
  if (agent === 'codex') {
    return line.includes('"type":"message"') || line.includes('"function_call')
      || line.includes('"reasoning"') || line.includes('"tool_search')
      || line.includes('"turn_context"');
  }
  // away_summary carries no `message` at all, so the role checks can't see it —
  // its own marker has to be in the gate or the recap never reaches the parser.
  return line.includes('"role":"user"') || line.includes('"role":"assistant"')
    || line.includes('"away_summary"');
}

function pushClaude(entry, state) {
  const out = [];
  // Checked BEFORE the `message` guard below: a recap is a `type:'system'` line
  // with a bare `content` string and no `message` object, so the guard would
  // drop it.
  if (entry.type === 'system' && entry.subtype === 'away_summary') {
    const recap = recapOf(entry.content);
    if (recap) out.push({ ...recap, ts: tsOf(entry.timestamp) });
    return out;
  }
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
    const { text, images } = userTextAndImages(msg.content);
    // `images.length` is part of the emit test, not just a decoration: an
    // image-only paste can leave no prose at all, and gating on text alone would
    // drop that turn from the stream entirely.
    if ((text || images.length) && !isSynthetic(text)) {
      out.push({ kind: 'user', text, ts, ...(images.length ? { images } : {}) });
    }
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
        setPending(state.pending, b.id, { id: b.id, name: b.name || 'tool', target: toolTarget(b.input), input: b.input ?? null });
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
    setPending(state.pending, p.call_id, {
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

// ---- Branch pruning --------------------------------------------------------
// A Claude transcript is a TREE, not a log, and nothing on disk marks which
// branch is the live one. Rewind ("backtrack", Esc-Esc) does not truncate the
// file: the new turn is appended with its `parentUuid` pointing back at the
// rewind target and the abandoned turns stay where they are, line-for-line
// indistinguishable from live ones. So a flat scan renders every version of the
// conversation the reader ever backed out of — measured over 274 real
// transcripts, 160 (58%) carry at least one abandoned line, and the worst case
// showed 325 of 345 message lines dead.
//
// The rule is NOT "keep the newest line and its ancestors". That spine is too
// narrow, because ordinary PARALLEL tool use branches the tree too: a second
// `tool_use` line and the first call's `tool_result` are both written as
// children of the first `tool_use`, so the spine silently drops live tool
// results — it does so in 153 of those 274 transcripts.
//
// What actually distinguishes a rewind is a branch point with more than one
// child whose SUBTREE CONTAINS A HUMAN PROMPT: two alternative histories. A
// parallel-tool fan-out never has that (one side is a bare tool result), so it
// is left alone. At such a point every prompt-bearing child but the LAST is
// dead, along with its whole subtree. Against the same corpus this prunes 1.7%
// of message lines and never drops a line the spine would have kept.
//
// `parentUuid: null` lines are grouped under one synthetic parent and compete
// the same way: rewinding to before the very first prompt starts a whole second
// root, which is how one recurring session accumulated eight of them. A uuid is
// always 36 hyphenated hex characters, so this sentinel cannot collide with one.
const ROOT = 'ROOT';

// The exemption to that grouping is a `compact_boundary` root — /compact also
// opens a new root, but it CONTINUES the conversation instead of replacing it,
// and letting it compete hid 2104 pre-compact messages of a real session. Such
// a node is also a WALL for the upward prompt walk, so the first prompt after a
// compact is not read as a rewind of the pre-compact root.
const COMPACT_MARKER = '"compact_boundary"';

// The parents map lives as long as the cached scanner (across contiguous polls)
// and there is one per session in that cache, so it needs a ceiling. Past the
// cap tracking stops and nothing is pruned — the pre-fix behaviour, which is
// the right way to fail: showing a dead branch is a cosmetic wrong, hiding a
// live turn is not.
export const MAX_TRACKED_LINES = 50000;

// Pulled off the RAW line by substring search, never JSON.parse. The chain has
// to include lines mightCarryChat deliberately never parses — an `attachment`
// sitting between a user turn and its reply is part of the parent chain, and a
// hole there orphans both sides — and some of those lines are multi-megabyte
// tool results. `"uuid":"` cannot false-match `"parentUuid":"` or
// `"leafUuid":"`: both capitalise the U, and neither has a quote before it.
function afterKey(line, key) {
  const at = line.indexOf(key);
  if (at === -1) return null;
  const from = at + key.length;
  const end = line.indexOf('"', from);
  return end === -1 ? null : line.slice(from, end);
}

export function lineUuids(line) {
  const uuid = afterKey(line, '"uuid":"');
  if (!uuid) return null;
  // `"parentUuid":null` is a root — a real position in the tree, not "unknown".
  return { uuid, parent: afterKey(line, '"parentUuid":"') || ROOT };
}

function track(line, state) {
  const ids = lineUuids(line);
  if (!ids || state.overflow) return ids;
  state.parents.set(ids.uuid, ids.parent);
  if (line.includes(COMPACT_MARKER)) state.walls.add(ids.uuid);
  if (state.parents.size > MAX_TRACKED_LINES) {
    state.overflow = true;
    state.parents.clear();
    state.walls.clear();
    state.promptChild.clear();
  }
  return ids;
}

// Called for a line that emitted a human prompt. Walks up recording which child
// each ancestor's prompt arrived through; an ancestor already recorded against a
// DIFFERENT child means this prompt hangs a second history off that point — a
// rewind. Amortised O(1): the walk stops the moment it reaches a node already
// recorded with the same child, so a linear conversation re-walks nothing.
function markPrompt(uuid, state) {
  let child = uuid;
  let node = state.parents.get(uuid);
  while (node) {
    const seen = state.promptChild.get(node);
    if (seen === child) return;
    if (seen !== undefined) state.rewound = true;
    state.promptChild.set(node, child);
    if (state.walls.has(node)) return;
    child = node;
    node = state.parents.get(node);
  }
}

// Shared, and never mutated by any caller — selectLive only reads `events`.
const NO_LINE = { uuid: null, events: [] };

export function createChatScanner(agent = 'claude') {
  const state = {
    agent, model: null, pending: new Map(),
    // Branch state, Claude only: a Codex rollout is a flat list with no parent
    // links and no rewind representation, so there is nothing to prune.
    parents: new Map(), walls: new Set(), promptChild: new Map(),
    overflow: false, rewound: false,
  };

  function pushTagged(line) {
    if (!line || !line.trim()) return NO_LINE;
    // Tracking runs BEFORE the gate and on every line — see the tree comment above.
    const ids = agent === 'claude' ? track(line, state) : null;
    const uuid = ids?.uuid ?? null;
    if (!mightCarryChat(line, agent)) return uuid ? { uuid, events: [] } : NO_LINE;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return uuid ? { uuid, events: [] } : NO_LINE; // a half-written trailing line is normal for a live session
    }
    const events = agent === 'codex' ? pushCodex(entry, state) : pushClaude(entry, state);
    // "This line is a human prompt" is read off the emitted event rather than
    // re-derived from the JSON: `kind: 'user'` already encodes isMeta, the
    // synthetic slash-command wrappers and tool_result-only content, and a second
    // copy of those rules would be a second thing to keep in step.
    if (uuid && events.some((e) => e.kind === 'user')) markPrompt(uuid, state);
    return { uuid, events };
  }

  return {
    // The uuid rides alongside the events rather than on them: pruning is decided
    // over a whole range (selectLive) and an event object carries no trace of the
    // line it came from, but nothing transcript-shaped should leak onto the wire.
    pushTagged,
    push(line) {
      return pushTagged(line).events;
    },
    pending() {
      const last = [...state.pending.values()].pop();
      return last ? { name: last.name, target: last.target } : null;
    },
    // Read-and-clear, and consumed on EVERY read rather than only the follow-up
    // one: a scan that starts at the window's beginning walks the historic branch
    // points too, and leaving the flag set would have the next poll rebuild a
    // stream that was just built correctly — a rebuild every 2s, forever.
    takeRewound() {
      const was = state.rewound;
      state.rewound = false;
      return was;
    },
    // Drops the events of lines on an abandoned branch. Only meaningful for a
    // scan that covers the range from its own start: it needs every line of that
    // range in hand, and it can only decide liveness for events it is about to
    // emit — it cannot retract events already delivered. A follow-up poll
    // therefore emits unfiltered and relies on takeRewound() instead.
    selectLive(tagged) {
      if (state.overflow) return tagged.flatMap((t) => t.events);
      const prompts = new Set();
      for (const t of tagged) {
        if (t.uuid && t.events.some((e) => e.kind === 'user')) prompts.add(t.uuid);
      }
      const kids = new Map();
      for (const [uuid, parent] of state.parents) {
        const list = kids.get(parent);
        if (list) list.push(uuid);
        else kids.set(parent, [uuid]);
      }
      // Reverse insertion order visits every child before its parent — a parent
      // is always written to the transcript ahead of its children — so one pass
      // is enough to lift "has a prompt below it" up the tree.
      const order = [...state.parents.keys()];
      const bearing = new Set();
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const uuid = order[i];
        if (prompts.has(uuid) || (kids.get(uuid) || []).some((c) => bearing.has(c))) bearing.add(uuid);
      }
      const deadRoots = new Set();
      for (const list of kids.values()) {
        if (list.length < 2) continue;
        const rivals = list.filter((c) => bearing.has(c) && !state.walls.has(c));
        for (let i = 0; i < rivals.length - 1; i += 1) deadRoots.add(rivals[i]);
      }
      if (!deadRoots.size) return tagged.flatMap((t) => t.events);
      const dead = new Set();
      for (const uuid of order) {
        if (deadRoots.has(uuid) || dead.has(state.parents.get(uuid))) dead.add(uuid);
      }
      // A line carrying no uuid is always kept: there is nothing to place it in
      // the tree with. Older transcript shapes and every test fixture are that.
      return tagged.flatMap((t) => (t.uuid && dead.has(t.uuid) ? [] : t.events));
    },
    // The timestamp of the newest transcript line this scanner has consumed,
    // which is how long ago the session last produced anything. The chat view
    // uses it as the elapsed clock for its working indicator: measuring from
    // when the VIEW mounted instead would report "3s" for a session that had
    // already been grinding for five minutes. Tracked off `prevTs`, which
    // pushClaude advances for every user and assistant entry — including an
    // assistant message that is nothing but a tool_use and so emits no event
    // at all, which is exactly the case the indicator has to cover.
    lastTs() {
      return state.prevTs ?? null;
    },
  };
}

// Whole-text scan, so branch pruning applies exactly as it does to the view's
// first read of a window.
export function scanChatText(text, agent = 'claude') {
  const scanner = createChatScanner(agent);
  const tagged = [];
  for (const line of text.split('\n')) tagged.push(scanner.pushTagged(line));
  return { events: scanner.selectLive(tagged), pending: scanner.pending() };
}
