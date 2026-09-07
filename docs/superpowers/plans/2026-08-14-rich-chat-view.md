# Rich Chat View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a chat view that renders a session's conversation from its on-disk transcript, with a composer that sends through the existing human message path, and a preference to switch between it and the terminal.

**Architecture:** A new pure leaf (`server/chat-events.js`) normalises Claude and Codex transcript lines into agent-agnostic chat events. A request/reply control handler tails the transcript by byte offset and returns bounded windows of those events. The client splits into pure grouping logic, DOM construction, and a controller that mounts into the existing `#term-wrap` slot.

**Tech Stack:** Node 20+, ESM, `node --test` (no test framework, no jsdom), vanilla DOM, vendored `markdown-it`.

**Spec:** `docs/superpowers/specs/2026-08-14-rich-chat-view-design.md` — read it first; this plan argues from it.

## Global Constraints

- **`server/chat-events.js` is a leaf.** It must not import `session-manager`, `state-reader`, `tmux-scraper`, or `server/index.js`. Those import *from* the leaf layer, never the reverse.
- **This path computes no cost.** No `$` arithmetic anywhere. Turn footers show model and tokens only. `subagent.usd` is forwarded from existing analysis, never recomputed.
- **The fork bound must NOT be applied.** Do not add a `createdAt`/`usageSince` cut to any read path here. A fork replaying parent history is correct for reading.
- **No `fs.watch` / chokidar.** Polled offset tail only.
- **Untrusted text.** Paths, tool targets, tool output, command text: `textContent`/`dataset`, never `innerHTML`. Only assistant markdown goes through `createRenderer`.
- **No hardcoded hex** in markup or JS. Semantic CSS variables from `public/styles.css`; must work in dark and light.
- **Per-session state keys on the card id**, never `liveSessionId`.
- **Codex `function_call` pairs on `call_id`, never `id`.**
- Tests: `npm test` runs `node --test`. Test files sit beside their source as `<name>.test.js`.
- `docs/` is gitignored; spec and plan files are tracked via `git add -f` (existing precedent).

---

### Task 1: Chat event leaf — Claude messages

**Files:**
- Create: `server/chat-events.js`
- Test: `server/chat-events.test.js`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces: `createChatScanner(agent) → { push(line), pending() }` where `push` returns an array of completed chat events for that line (usually 0 or 1); `MAX_TOOL_TEXT` constant; `scanChatText(text, agent) → { events, pending }`.

Event shapes produced by this task:
- `{ kind: 'user', text, ts }`
- `{ kind: 'assistant', text, ts, model }`
- `{ kind: 'thinking', ts, text }` (`durationMs` added in Task 4)

- [ ] **Step 1: Write the failing test**

```js
// server/chat-events.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanChatText } from './chat-events.js';

const claudeLines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n');

test('claude: a typed prompt and a reply become user + assistant events', () => {
  const text = claudeLines(
    { type: 'user', timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'user', content: 'why two keys?' } },
    { type: 'assistant', timestamp: '2026-08-14T10:00:04.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Because fan-in batches.' }] } },
  );
  const { events } = scanChatText(text, 'claude');
  assert.deepEqual(events, [
    { kind: 'user', text: 'why two keys?', ts: Date.parse('2026-08-14T10:00:00.000Z') },
    { kind: 'assistant', text: 'Because fan-in batches.', ts: Date.parse('2026-08-14T10:00:04.000Z'), model: 'claude-opus-5' },
  ]);
});

test('claude: thinking blocks emit their own event, before the text of the same message', () => {
  const text = claudeLines({
    type: 'assistant',
    timestamp: '2026-08-14T10:00:04.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [
      { type: 'thinking', thinking: 'Let me check both guards.' },
      { type: 'text', text: 'They differ.' },
    ] },
  });
  const { events } = scanChatText(text, 'claude');
  assert.deepEqual(events.map((e) => e.kind), ['thinking', 'assistant']);
  assert.equal(events[0].text, 'Let me check both guards.');
});

test('claude: isMeta and synthetic user turns are dropped', () => {
  const text = claudeLines(
    { type: 'user', isMeta: true, timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'user', content: 'injected' } },
    { type: 'user', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'user', content: '<environment_context>cwd=/x</environment_context>' } },
  );
  assert.deepEqual(scanChatText(text, 'claude').events, []);
});

test('a half-written trailing line is ignored, not thrown on', () => {
  const text = '{"type":"user","timestamp":"2026-08-14T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n{"type":"assis';
  assert.deepEqual(scanChatText(text, 'claude').events.map((e) => e.kind), ['user']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/chat-events.test.js`
Expected: FAIL — `Cannot find module './chat-events.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/chat-events.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/chat-events.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/chat-events.js server/chat-events.test.js
git commit -m "Add chat-event leaf with Claude message mapping"
```

---

### Task 2: Claude tool pairing, truncation and pending

**Files:**
- Modify: `server/chat-events.js`
- Test: `server/chat-events.test.js`

**Interfaces:**
- Consumes: `createChatScanner`, `MAX_TOOL_TEXT`, `scanChatText` from Task 1.
- Produces: `{ kind: 'tool', id, name, target, input, output, ok, ts, truncated }` events; `pending()` returns `{ name, target } | null`.

**Why a tool event is emitted only when its result arrives:** the view appends and never patches (a 2s poll that rewrote existing nodes would fight the reader). An in-flight call has no result yet, so emitting it early would require a later patch event. Instead the scanner exposes it via `pending()`, which the composer's "Working — running X" footer reads. An in-flight call is transient; the completed record is what the stream keeps.

- [ ] **Step 1: Write the failing test**

```js
// append to server/chat-events.test.js
import { scanChatText, MAX_TOOL_TEXT } from './chat-events.js';

test('claude: a tool_use pairs with its tool_result by tool_use_id', () => {
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/repo/a.js' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'export const a = 1;' },
    ] } },
  );
  const { events } = scanChatText(text, 'claude');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: 'tool', id: 'tu_1', name: 'Read', target: '/repo/a.js',
    input: { file_path: '/repo/a.js' }, output: 'export const a = 1;',
    ok: true, ts: Date.parse('2026-08-14T10:00:02.000Z'), truncated: false,
  });
});

test('claude: an unpaired tool_use emits nothing but shows up as pending', () => {
  const text = claudeLines({ type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_9', name: 'Bash', input: { command: 'npm test' } },
  ] } });
  const { events, pending } = scanChatText(text, 'claude');
  assert.deepEqual(events, []);
  assert.deepEqual(pending, { name: 'Bash', target: 'npm test' });
});

test('claude: is_error on the result sets ok false', () => {
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'false' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'exit 1' },
    ] } },
  );
  assert.equal(scanChatText(text, 'claude').events[0].ok, false);
});

test('oversized tool output is truncated and flagged', () => {
  const big = 'x'.repeat(MAX_TOOL_TEXT + 500);
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_3', name: 'Read', input: { file_path: '/big' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_3', content: big },
    ] } },
  );
  const ev = scanChatText(text, 'claude').events[0];
  assert.equal(ev.output.length, MAX_TOOL_TEXT);
  assert.equal(ev.truncated, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/chat-events.test.js`
Expected: FAIL — first new test fails, `events.length` is `0`

- [ ] **Step 3: Write minimal implementation**

Add to `server/chat-events.js`, and replace `pushClaude`'s early `return out` paths so tool blocks are handled:

```js
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
```

In `pushClaude`, inside the `msg.role === 'user'` branch, before the text handling, drain tool results:

```js
  if (msg.role === 'user') {
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type !== 'tool_result') continue;
        const open = state.pending.get(b.tool_use_id);
        if (!open) continue;
        state.pending.delete(b.tool_use_id);
        const { text: output, truncated } = cap(b.content);
        out.push({
          kind: 'tool', id: open.id, name: open.name, target: open.target,
          input: open.input, output, ok: b.is_error !== true, ts, truncated,
        });
      }
    }
    const text = textOf(msg.content);
    if (text && !isSynthetic(text)) out.push({ kind: 'user', text, ts });
    return out;
  }
```

In the assistant branch's block loop, record opens:

```js
      if (b?.type === 'tool_use' && b.id) {
        state.pending.set(b.id, { id: b.id, name: b.name || 'tool', target: toolTarget(b.input), input: b.input ?? null });
      }
```

And in `createChatScanner`, give the state a pending map and a real `pending()`:

```js
  const state = { agent, model: null, pending: new Map() };
  // …
    pending() {
      const last = [...state.pending.values()].pop();
      return last ? { name: last.name, target: last.target } : null;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/chat-events.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add server/chat-events.js server/chat-events.test.js
git commit -m "Pair Claude tool calls with their results, capped and with pending state"
```

---

### Task 3: Codex mapping

**Files:**
- Modify: `server/chat-events.js`
- Test: `server/chat-events.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: the same event kinds for `agent: 'codex'`. `thinking` events for Codex carry **no** `text` property.

**Verified against a real rollout** (`~/.codex/sessions/2026/07/16/rollout-…-019f6a55-….jsonl`), not assumed. Four rules, each with a regression test below:
1. `function_call` carries **both** `id` (`fc_…`) and `call_id` (`call_…`); the output carries only `call_id`. **Pair on `call_id`.** Pairing on `id` does not throw — it silently renders a timeline with no outputs.
2. `response_item/message` includes `role: "developer"` (injected permissions/instructions text). Filter it.
3. `reasoning` has `summary: []` and `encrypted_content`. There is no readable thinking text for Codex, ever.
4. `event_msg/agent_message` duplicates `response_item/message`. Skip it, or every assistant turn doubles.

- [ ] **Step 1: Write the failing test**

```js
// append to server/chat-events.test.js
const codexLines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n');

test('codex: user and assistant messages map, developer role is dropped', () => {
  const text = codexLines(
    { type: 'response_item', timestamp: '2026-08-14T10:00:00.000Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>' }] } },
    { type: 'response_item', timestamp: '2026-08-14T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review the PR' }] } },
    { type: 'response_item', timestamp: '2026-08-14T10:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] } },
  );
  const { events } = scanChatText(text, 'codex');
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['user', 'review the PR'], ['assistant', 'On it.']]);
});

test('codex: function_call pairs on call_id even though id differs', () => {
  const text = codexLines(
    { type: 'response_item', timestamp: '2026-08-14T10:00:01.000Z', payload: {
      type: 'function_call', id: 'fc_abc', call_id: 'call_xyz', name: 'exec_command',
      arguments: '{"cmd":"cat AGENTS.md"}',
    } },
    { type: 'response_item', timestamp: '2026-08-14T10:00:02.000Z', payload: {
      type: 'function_call_output', call_id: 'call_xyz', output: 'Process exited with code 0',
    } },
  );
  const { events } = scanChatText(text, 'codex');
  assert.equal(events.length, 1, 'pairing on `id` instead of `call_id` orphans the output');
  assert.equal(events[0].kind, 'tool');
  assert.equal(events[0].name, 'exec_command');
  assert.equal(events[0].target, 'cat AGENTS.md');
  assert.equal(events[0].output, 'Process exited with code 0');
});

test('codex: reasoning emits a thinking event with no text', () => {
  const text = codexLines({ type: 'response_item', timestamp: '2026-08-14T10:00:01.000Z', payload: {
    type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAAB…',
  } });
  const { events } = scanChatText(text, 'codex');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'thinking');
  assert.ok(!('text' in events[0]), 'codex reasoning is encrypted — never invent text for it');
});

test('codex: event_msg/agent_message is skipped as a duplicate of response_item/message', () => {
  const text = codexLines(
    { type: 'response_item', timestamp: '2026-08-14T10:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] } },
    { type: 'event_msg', timestamp: '2026-08-14T10:00:02.000Z', payload: { type: 'agent_message', message: 'On it.' } },
  );
  assert.equal(scanChatText(text, 'codex').events.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/chat-events.test.js`
Expected: FAIL — the Codex tests return `[]` (no Codex branch yet)

- [ ] **Step 3: Write minimal implementation**

```js
// server/chat-events.js — add alongside pushClaude
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
  // event_msg/agent_message and user_message repeat response_item/message
  // verbatim; indexing only response_item keeps every message exactly once.
  if (entry.type !== 'response_item') return out;
  const p = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
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
    return out;
  }

  // summary is always [] and the content is encrypted — presence only, never text.
  if (p.type === 'reasoning') {
    out.push({ kind: 'thinking', ts });
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
    return out;
  }

  if (p.type === 'function_call_output' || p.type === 'tool_search_output') {
    const open = state.pending.get(p.call_id);
    if (!open) return out;
    state.pending.delete(p.call_id);
    const { text: output, truncated } = cap(typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''));
    out.push({ kind: 'tool', id: open.id, name: open.name, target: open.target, input: open.input, output, ok: true, ts, truncated });
    return out;
  }
  return out;
}
```

Dispatch in `createChatScanner`'s `push`:

```js
      return agent === 'codex' ? pushCodex(entry, state) : pushClaude(entry, state);
```

Widen the Codex gate in `mightCarryChat` to admit `tool_search`:

```js
  if (agent === 'codex') {
    return line.includes('"type":"message"') || line.includes('"function_call')
      || line.includes('"reasoning"') || line.includes('"tool_search');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/chat-events.test.js`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add server/chat-events.js server/chat-events.test.js
git commit -m "Map Codex rollout lines to chat events, pairing on call_id"
```

---

### Task 4: Thinking duration, notices, and subagent spawn points

**Files:**
- Modify: `server/chat-events.js`
- Test: `server/chat-events.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `durationMs` on `thinking` events where derivable; `{ kind: 'notice', noticeKind, text, ts }`; `{ kind: 'subagent', id, name, ts }`.

Three additions:

1. **`durationMs`** is derived from the gap between the previous line's timestamp and this one. Neither agent records a thinking duration, so this is the only place the information exists. When it cannot be derived (no previous timestamp) the field is **omitted** — the view then reads plain `Thinking` rather than guessing.
2. **`notice`** captures a *resolved* permission decision, which surfaces in the `tool_result` text once answered. This is what makes the needs-you handoff auditable after the fact.
3. **`subagent`** marks the *spawn point* only — name and id from the `Task`/`Agent` tool_use. Status and cost are read by the client from the graph's existing `s.subAgents`, so this does **not** re-implement the `subagents/` dir-versus-inline discriminator in `transcript-reader.js`. The chat stream supplies chronological position; the existing analysis supplies state.

- [ ] **Step 1: Write the failing test**

```js
// append to server/chat-events.test.js
test('thinking carries a duration derived from the previous line, omitted when unknown', () => {
  const first = claudeLines({ type: 'assistant', timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } });
  assert.ok(!('durationMs' in scanChatText(first, 'claude').events[0]));

  const pair = claudeLines(
    { type: 'user', timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'user', content: 'go' } },
    { type: 'assistant', timestamp: '2026-08-14T10:00:06.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } },
  );
  const think = scanChatText(pair, 'claude').events.find((e) => e.kind === 'thinking');
  assert.equal(think.durationMs, 6000);
});

test('a denied tool call emits a notice alongside the tool event', () => {
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_5', name: 'Bash', input: { command: 'git push' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:30.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_5', is_error: true, content: "The user doesn't want to proceed with this tool use." },
    ] } },
  );
  const { events } = scanChatText(text, 'claude');
  const notice = events.find((e) => e.kind === 'notice');
  assert.equal(notice.noticeKind, 'denied');
  assert.equal(notice.text, 'git push');
});

test('a Task tool_use emits a subagent spawn point', () => {
  const text = claudeLines({ type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_6', name: 'Task', input: { description: 'Explore mailbox guards', subagent_type: 'Explore' } },
  ] } });
  const { events } = scanChatText(text, 'claude');
  assert.deepEqual(events, [{ kind: 'subagent', id: 'tu_6', name: 'Explore mailbox guards', ts: Date.parse('2026-08-14T10:00:01.000Z') }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/chat-events.test.js`
Expected: FAIL — `durationMs` undefined; no `notice`; `Task` currently becomes a pending tool

- [ ] **Step 3: Write minimal implementation**

```js
// server/chat-events.js
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const DENIED_MARKERS = ["user doesn't want to proceed", 'user rejected', 'user denied'];

function noticeFor(open, resultText) {
  const low = resultText.toLowerCase();
  if (DENIED_MARKERS.some((m) => low.includes(m))) {
    return { kind: 'notice', noticeKind: 'denied', text: open.target || open.name };
  }
  return null;
}
```

Track the previous timestamp on the state (`state.prevTs`), set at the end of each `push` that parsed a line. Where a `thinking` event is created, add the duration only when derivable:

```js
        const think = { kind: 'thinking', ts };
        if (state.prevTs && ts > state.prevTs) think.durationMs = ts - state.prevTs;
        if (typeof b.thinking === 'string' && b.thinking.trim()) think.text = b.thinking.trim();
        out.push(think);
```

Apply the identical `prevTs` treatment in `pushCodex`'s `reasoning` branch (no `text`).

In the assistant `tool_use` branch, intercept sub-agent spawns before the pending map:

```js
      if (b?.type === 'tool_use' && b.id && SUBAGENT_TOOLS.has(b.name)) {
        const name = (b.input?.description || b.input?.subagent_type || b.name);
        out.push({ kind: 'subagent', id: b.id, name: oneLine(String(name)), ts });
        continue;
      }
```

In the `tool_result` drain, emit a notice when the result reads as a denial:

```js
        const notice = noticeFor(open, output);
        if (notice) out.push({ ...notice, ts });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/chat-events.test.js`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add server/chat-events.js server/chat-events.test.js
git commit -m "Add thinking duration, resolved-permission notices and subagent spawn points"
```

---

### Task 5: The `chat` control handler

**Files:**
- Create: `server/control/handlers/chat.js`
- Create: `server/control/handlers/chat.test.js`
- Modify: `server/control/handlers/index.js`

**Interfaces:**
- Consumes: `createChatScanner`, `MAX_TOOL_TEXT` (Task 1–4); `findTranscript` from `server/transcript-reader.js`.
- Produces: control message `{ type: 'chat', sessionId, events, offset, more, pending }`. Handler export name `chatHandler`, message type `'chat'`.

Request/reply to the requesting client only — the `subagent-detail`/`get-memory` pattern. Never broadcast: only one reader needs one session's conversation, and pushing transcripts to every open browser every 2s would be absurd.

Two bounds, both load-bearing:
- **Initial window.** `sinceOffset == null` means "first open": read only the trailing `WINDOW_BYTES` of the file and set `more: true` if bytes were skipped. `sinceOffset` bounds the *tail* only, so without this a months-old transcript is parsed and shipped whole. *(Superseded after implementation: `WINDOW_BYTES` is now only the FIRST attempt's size — the window doubles backwards until ~`TARGET_EVENTS` events are in view, byte 0 is reached, or `MAX_INITIAL_BYTES` caps it. The bound on a months-old transcript is unchanged in kind, only measured in events.)*
- **Seam correctness.** The window starts at the first newline at or after the cut, so a partial first line is never parsed. Returned `offset` is always a line boundary.

- [ ] **Step 1: Write the failing test**

```js
// server/control/handlers/chat.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatHandler, WINDOW_BYTES } from './chat.js';

async function tmpTranscript(lines) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-chat-'));
  const file = path.join(dir, 'conv.jsonl');
  await fsp.writeFile(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return file;
}

function ctx(file, node = { liveSessionId: 'live-1', agent: 'claude' }) {
  const sent = [];
  return { sent, reply: (o) => sent.push(o), sessionFromGraph: () => node, findTranscript: async () => file };
}

const userLine = (t, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: t } });

test('chat: replies with events and a line-boundary offset', async () => {
  const file = await tmpTranscript([userLine('one', '2026-08-14T10:00:00.000Z'), userLine('two', '2026-08-14T10:00:01.000Z')]);
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const reply = c.sent[0];
  assert.equal(reply.type, 'chat');
  assert.equal(reply.sessionId, 'card-1', 'echoes the CARD id the client sent');
  assert.deepEqual(reply.events.map((e) => e.text), ['one', 'two']);
  assert.equal(reply.offset, fs.statSync(file).size);
  assert.equal(reply.more, false);
});

test('chat: a follow-up poll from the previous offset returns only new events', async () => {
  const file = await tmpTranscript([userLine('one', '2026-08-14T10:00:00.000Z')]);
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const { offset } = c.sent[0];
  await fsp.appendFile(file, JSON.stringify(userLine('two', '2026-08-14T10:00:01.000Z')) + '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: offset }, c);
  assert.deepEqual(c.sent[1].events.map((e) => e.text), ['two']);
});

test('chat: a long transcript returns a bounded window with more:true', async () => {
  const many = Array.from({ length: 4000 }, (_, i) => userLine(`msg ${i} ${'pad'.repeat(20)}`, '2026-08-14T10:00:00.000Z'));
  const file = await tmpTranscript(many);
  assert.ok(fs.statSync(file).size > WINDOW_BYTES, 'fixture must exceed the window to exercise the bound');
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const reply = c.sent[0];
  assert.equal(reply.more, true);
  assert.ok(reply.events.length < many.length);
  assert.equal(reply.events.at(-1).text, `msg 3999 ${'pad'.repeat(20)}`, 'the window keeps the NEWEST events');
});

test('chat: a missing transcript replies with an empty stream, not an error', async () => {
  const c = ctx(null);
  c.findTranscript = async () => null;
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.deepEqual(c.sent[0].events, []);
  assert.equal(c.sent[0].offset, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/control/handlers/chat.test.js`
Expected: FAIL — `Cannot find module './chat.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/control/handlers/chat.js
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { findTranscript as realFindTranscript } from '../../transcript-reader.js';
import { createChatScanner } from '../../chat-events.js';

// The first open reads only the trailing slice of the transcript. sinceOffset
// bounds the TAIL; without this bound, opening a months-old session parses and
// ships its whole history before the view can draw anything.
export const WINDOW_BYTES = 256 * 1024;

// On-demand, uncached read of one session's conversation. A fresh, TARGETED reply
// to the requesting client only (like subagent-detail / get-memory), never
// broadcast — only the reader of this session needs it. findTranscript is a ctx
// seam for test isolation.
export const chatHandler = {
  type: 'chat',
  async handler(msg, ctx) {
    const findTranscript = ctx.findTranscript || realFindTranscript;
    // The client sends the CARD id; the transcript is named by the CONVERSATION
    // id. Resolve card → liveSessionId off the graph, falling back to the card id
    // for legacy pre-split entries — the same resolution subagent-detail.js does.
    const node = ctx.sessionFromGraph?.(msg.sessionId);
    const convId = node?.liveSessionId || msg.sessionId;
    const agent = node?.agent === 'codex' ? 'codex' : 'claude';

    const file = await findTranscript(convId);
    if (!file) {
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, events: [], offset: 0, more: false, pending: null });
      return;
    }

    let size = 0;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, events: [], offset: 0, more: false, pending: null });
      return;
    }

    const since = Number.isFinite(msg.sinceOffset) ? Math.max(0, Math.min(msg.sinceOffset, size)) : null;
    let start = since ?? Math.max(0, size - WINDOW_BYTES);
    const windowed = since == null && start > 0;

    const handle = await fsp.open(file, 'r');
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      let text = buf.toString('utf8');
      // Never parse a partial first line: on a windowed read, skip to the first
      // newline so `start` (and therefore every later offset) is a line boundary.
      if (windowed) {
        const nl = text.indexOf('\n');
        if (nl === -1) {
          ctx.reply({ type: 'chat', sessionId: msg.sessionId, events: [], offset: size, more: true, pending: null });
          return;
        }
        start += Buffer.byteLength(text.slice(0, nl + 1), 'utf8');
        text = text.slice(nl + 1);
      }
      // A trailing partial line (normal for a live session) is left for the next
      // poll: the returned offset stops at the last complete newline.
      const lastNl = text.lastIndexOf('\n');
      const complete = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
      const scanner = createChatScanner(agent);
      const events = [];
      for (const line of complete.split('\n')) events.push(...scanner.push(line));
      const offset = start + Buffer.byteLength(complete, 'utf8');
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, events, offset, more: windowed, pending: scanner.pending() });
    } finally {
      await handle.close();
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/control/handlers/chat.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Register the handler**

In `server/control/handlers/index.js`, add the import beside `subagentDetailHandler`'s and add `chatHandler` to the `CONTROL_HANDLERS` array:

```js
import { chatHandler } from './chat.js';
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — no regressions

- [ ] **Step 7: Commit**

```bash
git add server/control/handlers/chat.js server/control/handlers/chat.test.js server/control/handlers/index.js
git commit -m "Add the chat control handler with bounded windows and offset tailing"
```

---

### Task 6: The preference

**Files:**
- Modify: `server/config-store.js`
- Modify: `server/index.js:462`
- Create: `server/control/handlers/chat-view-default.js`
- Modify: `server/control/handlers/index.js`
- Modify: `public/settings.js:29-53`
- Modify: `public/app.js:117`, `public/app.js:295`, `public/app.js:4115-4130`
- Test: `server/config-store.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `chatViewDefault(cfg)` from `config-store.js`; graph field `graph.chatViewDefault`; control message type `'set-chat-view-default'`; setting id `'chatViewDefault'` readable via `getSetting('chatViewDefault')`.

Mirrors `subagentsExpandedByDefault` end to end — same shape of setting ("what a per-session toggle defaults to"), so it follows the same pattern rather than inventing a second one. **Defaults to terminal (`false`)**: the terminal is current behaviour and silently changing what the board does on upgrade is intrusive.

- [ ] **Step 1: Write the failing test**

```js
// append to server/config-store.test.js
import { chatViewDefault } from './config-store.js';

test('chatViewDefault defaults to false (terminal) and is opt-in', () => {
  assert.equal(chatViewDefault({}), false);
  assert.equal(chatViewDefault({ chatViewDefault: true }), true);
  assert.equal(chatViewDefault({ chatViewDefault: 'yes' }), false, 'only a real boolean true opts in');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/config-store.test.js`
Expected: FAIL — `chatViewDefault is not a function`

- [ ] **Step 3: Add the config reader**

```js
// server/config-store.js — after subagentsExpandedByDefault
// Which view a session's sidebar opens in for cards the user hasn't explicitly
// toggled either way. Default off (terminal) to preserve today's behaviour;
// toggled from the board's settings modal (config.json `chatViewDefault: true`).
// Takes cfg (like subagentsExpandedByDefault) so tests never write the shared
// config.json — `node --test` runs files in parallel against the same real file.
export function chatViewDefault(cfg = readConfig()) {
  return cfg.chatViewDefault === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/config-store.test.js`
Expected: PASS

- [ ] **Step 5: Add the control handler**

```js
// server/control/handlers/chat-view-default.js
import { writeConfig } from '../../config-store.js';

export const chatViewDefaultHandler = {
  type: 'set-chat-view-default',
  async handler(msg, ctx) {
    // Global (per-install) default, not per-session — persists in config.json so
    // every browser agrees. The rebuild re-broadcasts the graph carrying the new
    // flag, which is what a card with no explicit override reads.
    writeConfig({ chatViewDefault: Boolean(msg.enabled) });
    await ctx.rebuild();
  },
};
```

Register it in `server/control/handlers/index.js` exactly as Task 5 did for `chatHandler`.

- [ ] **Step 6: Carry the flag on the graph**

In `server/index.js`, extend the `config-store.js` import to include `chatViewDefault`, then add beside line 462:

```js
  graph.chatViewDefault = chatViewDefault();
```

- [ ] **Step 7: Add the settings row**

Append to the `SETTINGS` array in `public/settings.js`:

```js
  {
    id: 'chatViewDefault',
    type: 'toggle',
    scope: 'server',
    label: 'Open sessions in chat view',
    help: 'Whether a session\'s sidebar opens in the rich chat view or the terminal. A session you have switched by hand keeps its own choice regardless of this setting.',
    default: false,
  },
```

- [ ] **Step 8: Wire the app.js bridge**

Beside `public/app.js:117` add the module-level flag, mirroring its neighbour:

```js
let chatViewDefault = false; // server config flag, carried on every graph push
```

Beside line 295 (where `subagentsExpandedByDefault` is read off the graph):

```js
  chatViewDefault = graph.chatViewDefault === true;
```

In the `initSettings` server bridge (around line 4119), extend `get` and `set`:

```js
      if (id === 'chatViewDefault') return chatViewDefault;
      // …
      } else if (id === 'chatViewDefault') {
        chatViewDefault = Boolean(value);
        send({ type: 'set-chat-view-default', enabled: chatViewDefault });
```

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add server/config-store.js server/config-store.test.js server/control/handlers/chat-view-default.js server/control/handlers/index.js server/index.js public/settings.js public/app.js
git commit -m "Add the chatViewDefault preference, defaulting to the terminal"
```

---

### Task 7: Pure grouping logic

**Files:**
- Create: `public/chat-group.js`
- Test: `public/chat-group.test.js`

**Interfaces:**
- Consumes: the event shapes from Tasks 1–4.
- Produces: `groupChatEvents(events) → renderItem[]`, where a render item is one of:
  - `{ type: 'user' | 'assistant' | 'thinking' | 'notice' | 'subagent', event }`
  - `{ type: 'activity', label, tools, adds, dels }`
- Also produces: `activityLabel(tools) → string`.

This is direction C's one new concept and the module most worth testing, because grouping *is* the design. Rules:
- A run of consecutive `tool` events with nothing else between them collapses into one `activity` item.
- Any non-tool event closes an open run.
- The label counts by verb class: read-ish, edit-ish, run-ish, search-ish.
- An edit run rolls up `+N −M` from each edit tool's counts when present.

- [ ] **Step 1: Write the failing test**

```js
// public/chat-group.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupChatEvents, activityLabel } from './chat-group.js';

const tool = (name, target, extra = {}) => ({ kind: 'tool', name, target, ok: true, ts: 1, ...extra });
const say = (text) => ({ kind: 'assistant', text, ts: 1 });

test('a run of consecutive tool events collapses into one activity item', () => {
  const items = groupChatEvents([
    say('checking'),
    tool('Read', '/a.js'), tool('Read', '/b.js'), tool('Grep', 'settleKey'),
    say('done'),
  ]);
  assert.deepEqual(items.map((i) => i.type), ['assistant', 'activity', 'assistant']);
  assert.equal(items[1].tools.length, 3);
});

test('prose between two tool runs splits them into separate activity items', () => {
  const items = groupChatEvents([tool('Read', '/a.js'), say('hm'), tool('Read', '/b.js')]);
  assert.deepEqual(items.map((i) => i.type), ['activity', 'assistant', 'activity']);
});

test('a lone tool call still becomes an activity item', () => {
  const items = groupChatEvents([tool('Bash', 'npm test')]);
  assert.deepEqual(items.map((i) => i.type), ['activity']);
  assert.equal(items[0].tools.length, 1);
});

test('activityLabel counts by verb class', () => {
  assert.equal(activityLabel([tool('Read', '/a'), tool('Read', '/b'), tool('Grep', 'x')]), 'Read 2 files, 1 search');
  assert.equal(activityLabel([tool('Edit', '/a')]), 'Edited 1 file');
  assert.equal(activityLabel([tool('Bash', 'ls'), tool('Bash', 'pwd')]), 'Ran 2 commands');
});

test('an edit run rolls up its +/- counts', () => {
  const items = groupChatEvents([
    tool('Edit', '/a.js', { adds: 8, dels: 1 }),
    tool('Write', '/b.js', { adds: 3, dels: 1 }),
  ]);
  assert.equal(items[0].adds, 11);
  assert.equal(items[0].dels, 2);
});

test('non-tool events pass through in order, each as its own item', () => {
  const items = groupChatEvents([
    { kind: 'user', text: 'go', ts: 1 },
    { kind: 'thinking', ts: 2, durationMs: 6000 },
    { kind: 'subagent', id: 'tu_1', name: 'Explore', ts: 3 },
    { kind: 'notice', noticeKind: 'denied', text: 'git push', ts: 4 },
  ]);
  assert.deepEqual(items.map((i) => i.type), ['user', 'thinking', 'subagent', 'notice']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/chat-group.test.js`
Expected: FAIL — `Cannot find module './chat-group.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// public/chat-group.js
// Pure logic for the chat view's activity grouping (chat-view.js), split out so it
// can be unit-tested without a DOM — the same split search-browse.js / layout.js /
// diff.js already use.
//
// Direction C's whole premise: prose reads first, machinery collapses. A run of
// consecutive tool events with no other event between them becomes ONE expandable
// activity chip, so a turn that read nine files reads as one line instead of nine.

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'view_image']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'tool_search_call']);

function classOf(name) {
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (SEARCH_TOOLS.has(name)) return 'search';
  return 'run';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function activityLabel(tools) {
  const counts = { read: 0, edit: 0, search: 0, run: 0 };
  for (const t of tools) counts[classOf(t.name)] += 1;
  const parts = [];
  if (counts.edit) parts.push(`Edited ${plural(counts.edit, 'file', 'files')}`);
  if (counts.read) parts.push(`Read ${plural(counts.read, 'file', 'files')}`);
  if (counts.search) parts.push(plural(counts.search, 'search', 'searches'));
  if (counts.run) parts.push(`Ran ${plural(counts.run, 'command', 'commands')}`);
  return parts.join(', ');
}

export function groupChatEvents(events) {
  const items = [];
  let run = null;
  const closeRun = () => {
    if (!run) return;
    items.push({
      type: 'activity',
      label: activityLabel(run),
      tools: run,
      adds: run.reduce((n, t) => n + (t.adds || 0), 0),
      dels: run.reduce((n, t) => n + (t.dels || 0), 0),
    });
    run = null;
  };
  for (const event of events || []) {
    if (event.kind === 'tool') {
      (run ||= []).push(event);
      continue;
    }
    closeRun();
    items.push({ type: event.kind, event });
  }
  closeRun();
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test public/chat-group.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add public/chat-group.js public/chat-group.test.js
git commit -m "Add pure activity-grouping logic for the chat view"
```

---

### Task 8: DOM construction

**Files:**
- Create: `public/chat-dom.js`
- Test: `public/chat-dom.test.js`

**Interfaces:**
- Consumes: `groupChatEvents` (Task 7); `createRenderer` from `public/markdown-preview.js`.
- Produces: `createChatDom({ renderMarkdown }) → { itemNode(item) → HTMLElement }`; `activityTitle(item) → string`.

**The security rule this task exists to enforce:** chat content is agent- and repo-generated. Paths, tool targets, tool output and command text go in via `textContent`/`dataset`, **never `innerHTML`** — the rule `diff-dom.js` states for the same class of content. The single exception is assistant markdown, rendered through the existing `createRenderer(window.markdownit)`, which is already the safe-by-default choice (`html:false` escapes raw HTML rather than passing it through; `validateLink` drops `javascript:`/`vbscript:`/`data:`) and therefore needs no separate sanitiser pass.

`renderMarkdown` is injected rather than imported so this module tests without `window.markdownit` — the same argument `markdown-preview.js` already makes for taking the factory as an argument.

- [ ] **Step 1: Write the failing test**

```js
// public/chat-dom.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatDom, activityTitle } from './chat-dom.js';

// A DOM stub sufficient for the node-building assertions: no jsdom, matching how
// the rest of public/ tests stay DOM-free.
function stubDocument() {
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], className: '', dataset: {},
      _text: null, _html: null, attrs: {},
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      set textContent(v) { this._text = v; },
      get textContent() { return this._text; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
    };
    return el;
  };
  return { createElement: make };
}

const walk = (node, out = []) => {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
};

test('tool output and targets never reach innerHTML', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: (s) => `<p>${s}</p>` });
  const node = dom.itemNode({
    type: 'activity', label: 'Ran 1 command', adds: 0, dels: 0,
    tools: [{ kind: 'tool', name: 'Bash', target: '<img src=x onerror=alert(1)>', output: '<script>bad()</script>', ok: true }],
  });
  const html = walk(node).map((n) => n._html).filter(Boolean).join('');
  assert.equal(html, '', 'no innerHTML anywhere in a tool subtree');
  const texts = walk(node).map((n) => n._text).filter(Boolean);
  assert.ok(texts.some((t) => t.includes('<img src=x')), 'the raw string is carried as text, not markup');
});

test('assistant prose is the one thing rendered as markdown', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: (s) => `<p>${s.toUpperCase()}</p>` });
  const node = dom.itemNode({ type: 'assistant', event: { kind: 'assistant', text: 'hello', ts: 1, model: 'claude-opus-5' } });
  const html = walk(node).map((n) => n._html).filter(Boolean).join('');
  assert.equal(html, '<p>HELLO</p>');
});

test('a user turn is plain text, never markdown', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '<p>nope</p>' });
  const node = dom.itemNode({ type: 'user', event: { kind: 'user', text: '**not bold**', ts: 1 } });
  assert.equal(walk(node).map((n) => n._html).filter(Boolean).join(''), '');
  assert.ok(walk(node).some((n) => n._text === '**not bold**'));
});

test('activityTitle appends the diff counts only when an edit run has them', () => {
  assert.equal(activityTitle({ label: 'Edited 2 files', adds: 11, dels: 2 }), 'Edited 2 files +11 −2');
  assert.equal(activityTitle({ label: 'Read 2 files', adds: 0, dels: 0 }), 'Read 2 files');
});

test('a codex thinking item with no text renders without a duration or body', () => {
  const dom = createChatDom({ document: stubDocument(), renderMarkdown: () => '' });
  const node = dom.itemNode({ type: 'thinking', event: { kind: 'thinking', ts: 1 } });
  assert.ok(walk(node).some((n) => n._text === 'Thinking'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test public/chat-dom.test.js`
Expected: FAIL — `Cannot find module './chat-dom.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// public/chat-dom.js
// Node construction for the chat view. The rule this module exists to enforce:
// chat content is agent- and repo-generated, so paths, tool targets, tool output
// and command text go in via textContent/dataset and NEVER innerHTML — the same
// rule diff-dom.js states for the same class of content.
//
// The single exception is assistant markdown, which goes through the renderer
// injected as `renderMarkdown` (markdown-preview.js's createRenderer in the
// browser). That renderer is already safe by default — html:false escapes raw
// HTML rather than passing it through, and validateLink drops javascript:/
// vbscript:/data: — so its output needs no separate sanitiser pass. It is
// injected rather than imported so this module tests with no window and no jsdom.

export function activityTitle(item) {
  if (!item.adds && !item.dels) return item.label;
  return `${item.label} +${item.adds} −${item.dels}`;
}

const AGO = (ms) => `${Math.round(ms / 1000)}s`;

export function createChatDom({ document: doc = globalThis.document, renderMarkdown } = {}) {
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function toolRow(t) {
    const row = el('div', 'chat-tool-row');
    row.appendChild(el('span', 'chat-tool-name', t.name));
    row.appendChild(el('span', 'chat-tool-target', t.target || ''));
    if (t.output) {
      const pre = el('pre', 'chat-tool-output', t.output);
      if (t.truncated) pre.dataset.truncated = '1';
      row.appendChild(pre);
    }
    if (t.ok === false) row.dataset.failed = '1';
    return row;
  }

  function activityNode(item) {
    const wrap = el('div', 'chat-activity');
    const chip = el('button', 'chat-activity-chip');
    chip.setAttribute('type', 'button');
    chip.setAttribute('aria-expanded', 'false');
    chip.appendChild(el('span', 'chat-activity-label', activityTitle(item)));
    wrap.appendChild(chip);
    const body = el('div', 'chat-activity-body');
    body.dataset.collapsed = '1';
    for (const t of item.tools) body.appendChild(toolRow(t));
    wrap.appendChild(body);
    return wrap;
  }

  function itemNode(item) {
    if (item.type === 'activity') return activityNode(item);
    const e = item.event;
    if (item.type === 'user') {
      return el('div', 'chat-user', e.text);
    }
    if (item.type === 'assistant') {
      const wrap = el('div', 'chat-assistant');
      const prose = el('div', 'chat-prose');
      prose.innerHTML = renderMarkdown(e.text); // the one sanctioned innerHTML
      wrap.appendChild(prose);
      const foot = el('div', 'chat-turn-foot');
      if (e.model) foot.appendChild(el('span', 'chat-model', e.model));
      wrap.appendChild(foot);
      return wrap;
    }
    if (item.type === 'thinking') {
      const wrap = el('div', 'chat-thinking');
      wrap.appendChild(el('span', 'chat-thinking-label', e.durationMs ? `Thought for ${AGO(e.durationMs)}` : 'Thinking'));
      if (e.text) {
        const body = el('div', 'chat-thinking-body', e.text);
        body.dataset.collapsed = '1';
        wrap.appendChild(body);
      }
      return wrap;
    }
    if (item.type === 'subagent') {
      const wrap = el('div', 'chat-subagent');
      wrap.dataset.subagentId = e.id;
      wrap.appendChild(el('span', 'chat-subagent-name', e.name));
      return wrap;
    }
    const wrap = el('div', 'chat-notice');
    wrap.dataset.noticeKind = e.noticeKind || 'info';
    wrap.appendChild(el('span', 'chat-notice-text', `${e.noticeKind === 'denied' ? 'Denied' : 'Resolved'}: ${e.text}`));
    return wrap;
  }

  return { itemNode };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test public/chat-dom.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add public/chat-dom.js public/chat-dom.test.js
git commit -m "Add chat DOM construction, keeping untrusted text out of innerHTML"
```

---

### Task 9: The view controller

**Files:**
- Create: `public/chat-view.js`
- Modify: `public/index.html:131-133`

**Interfaces:**
- Consumes: `groupChatEvents` (Task 7), `createChatDom` (Task 8), `createRenderer` from `public/markdown-preview.js`, the `chat` control message (Task 5).
- Produces: `initChatView({ send, onSubagentClick, onOpenDiff }) → { mount(sessionId), unmount(), onChatReply(msg), setStatus(status) }`.

**Append, never re-render.** Each poll appends nodes for new events only. `renderPanel` already documents the trap: reassigning `innerHTML` restarts the CSS throb mid-cycle and resets scroll. On a 2s cadence a full re-render would fight the reader continuously.

- [ ] **Step 1: Add the DOM slot**

In `public/index.html`, inside `#sidebar` beside `#term-wrap`:

```html
      <div id="chat-wrap" hidden>
        <div id="chat-stream" class="chat-stream" aria-live="polite"></div>
        <div id="chat-notice-bar" class="chat-notice-bar" hidden></div>
        <div id="chat-composer" class="chat-composer">
          <div class="chat-working" id="chat-working" hidden></div>
          <div class="chat-box">
            <textarea id="chat-input" rows="1" placeholder="Send a prompt…"></textarea>
            <button type="button" id="chat-stop" class="chat-stop" hidden>Stop</button>
            <button type="button" id="chat-send" class="chat-send">Send</button>
          </div>
          <div class="chat-hint" id="chat-hint"></div>
        </div>
      </div>
```

- [ ] **Step 2: Write the controller**

```js
// public/chat-view.js
// The chat view controller: mounts into the #chat-wrap slot beside #term-wrap,
// owns the poll loop, scroll anchoring and the composer.
//
// APPEND, NEVER RE-RENDER. renderPanel (app.js) already documents why
// reassigning innerHTML is a trap — it restarts the CSS throb mid-cycle and
// resets scroll. At a 2s cadence a full re-render would fight the reader
// continuously, so each reply appends nodes for its new events only.

import { groupChatEvents } from './chat-group.js';
import { createChatDom } from './chat-dom.js';
import { createRenderer } from './markdown-preview.js';

const POLL_MS = 2000;
const BOTTOM_SLACK_PX = 40;

export function initChatView({ send, onSubagentClick, onOpenDiff } = {}) {
  const wrap = document.getElementById('chat-wrap');
  const stream = document.getElementById('chat-stream');
  const dom = createChatDom({ renderMarkdown: createRenderer(window.markdownit) });

  let sessionId = null;
  let offset = null;
  let timer = null;
  // Carried across polls so a tool run split across two replies still collapses
  // into one activity chip instead of two: the tail events of the previous reply
  // are re-grouped with the new ones, and only the newly-produced items append.
  let carry = [];

  const atBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight < BOTTOM_SLACK_PX;

  function appendItems(items) {
    const stick = atBottom();
    for (const item of items) {
      const node = dom.itemNode(item);
      if (item.type === 'subagent') {
        node.addEventListener('click', () => onSubagentClick?.(sessionId, item.event.id));
      }
      if (item.type === 'activity' && item.adds + item.dels > 0) {
        node.querySelector('.chat-activity-chip')?.addEventListener('dblclick', () => onOpenDiff?.(sessionId));
      }
      if (item.type === 'activity') {
        const chip = node.querySelector('.chat-activity-chip');
        const body = node.querySelector('.chat-activity-body');
        chip?.addEventListener('click', () => {
          const open = body.dataset.collapsed === '1';
          body.dataset.collapsed = open ? '0' : '1';
          chip.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      }
      stream.appendChild(node);
    }
    if (stick) stream.scrollTop = stream.scrollHeight;
  }

  function poll() {
    if (!sessionId) return;
    send({ type: 'chat', sessionId, ...(offset == null ? {} : { sinceOffset: offset }) });
  }

  return {
    mount(id) {
      if (sessionId === id) return;
      sessionId = id;
      offset = null;
      carry = [];
      stream.textContent = '';
      wrap.hidden = false;
      poll();
      clearInterval(timer);
      timer = setInterval(poll, POLL_MS);
    },
    unmount() {
      clearInterval(timer);
      timer = null;
      sessionId = null;
      wrap.hidden = true;
      stream.textContent = '';
    },
    onChatReply(msg) {
      if (!sessionId || msg.sessionId !== sessionId) return;
      offset = msg.offset;
      // Re-group the carried tail with the new events, then append only what is
      // genuinely new. `carry` holds the trailing tool run, which is the only
      // thing a later reply can still extend.
      const merged = groupChatEvents([...carry, ...msg.events]);
      const already = groupChatEvents(carry).length;
      appendItems(merged.slice(already));
      const tail = [];
      for (let i = msg.events.length - 1; i >= 0 && msg.events[i].kind === 'tool'; i--) tail.unshift(msg.events[i]);
      carry = tail;
      const working = document.getElementById('chat-working');
      if (msg.pending) {
        working.textContent = `Working — running ${msg.pending.name}${msg.pending.target ? `: ${msg.pending.target}` : ''}`;
        working.hidden = false;
      } else {
        working.hidden = true;
      }
    },
    setStatus(status) {
      const bar = document.getElementById('chat-notice-bar');
      const stop = document.getElementById('chat-stop');
      bar.hidden = status !== 'needs-you';
      if (status === 'needs-you') {
        bar.textContent = '';
        const msg = document.createElement('span');
        msg.textContent = 'Waiting on you — answer in the terminal';
        bar.appendChild(msg);
      }
      stop.hidden = status !== 'working';
    },
  };
}
```

- [ ] **Step 3: Verify it loads without error**

Run: `node --check public/chat-view.js`
Expected: no output (syntax valid). Full behaviour is exercised in Task 13's browser pass.

- [ ] **Step 4: Commit**

```bash
git add public/chat-view.js public/index.html
git commit -m "Add the chat view controller and its sidebar slot"
```

---

### Task 10: The toggle and per-session override

**Files:**
- Modify: `public/app.js` (near `renderPanel`, ~line 3113-3174, and the `chat` WS message dispatch)
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `initChatView` (Task 9), `chatViewDefault` graph flag (Task 6).
- Produces: `viewForSession(sessionId) → 'chat' | 'terminal'`; `setSessionView(sessionId, view)`.

The toggle is a segmented `Chat / Terminal` control in the `#panel` header — the same idiom the diff panel already uses for `Uncommitted / Full branch`, which is the same job (two views of one thing). The per-session override keys on **card id** and persists to `localStorage`, following the precedent diff review drafts already set.

- [ ] **Step 1: Add the override store**

Near the other per-session maps in `public/app.js` (beside `panelSubagentShownOverrides`, ~line 3038):

```js
// Which view each session's sidebar shows. Keyed on the CARD id (never the live
// id) like every other per-session field, and persisted so a reload keeps your
// choice. A session toggled by hand keeps it no matter how chatViewDefault moves.
const CHAT_VIEW_KEY = 'cm-session-view';
function readSessionViews() {
  try { return JSON.parse(localStorage.getItem(CHAT_VIEW_KEY)) || {}; } catch { return {}; }
}
function viewForSession(sessionId) {
  const stored = readSessionViews()[sessionId];
  if (stored === 'chat' || stored === 'terminal') return stored;
  return chatViewDefault ? 'chat' : 'terminal';
}
function setSessionView(sessionId, view) {
  const all = readSessionViews();
  all[sessionId] = view;
  try { localStorage.setItem(CHAT_VIEW_KEY, JSON.stringify(all)); } catch {}
}
```

- [ ] **Step 2: Render the segmented control**

In `renderPanel`'s `.sess-acts` span (public/app.js:3116-3121), before the Actions button:

```js
            <span class="chat-seg" role="group" aria-label="Session view">
              <button type="button" class="chat-seg-btn${view === 'chat' ? ' on' : ''}" data-view="chat" aria-pressed="${view === 'chat'}">Chat</button>
              <button type="button" class="chat-seg-btn${view === 'terminal' ? ' on' : ''}" data-view="terminal" aria-pressed="${view === 'terminal'}">Terminal</button>
            </span>
```

with `const view = viewForSession(sessionId);` computed at the top of `renderPanel` beside the other per-session lookups.

- [ ] **Step 3: Wire the click handler**

After the existing `#actions-btn` wiring in `renderPanel`:

```js
  panel.querySelectorAll('.chat-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view;
      if (next === viewForSession(sessionId)) return;
      setSessionView(sessionId, next);
      applySessionView(sessionId);
      renderPanel(sessionId);
    });
  });
```

- [ ] **Step 4: Add the view switch**

```js
// Show exactly one of the two views for the selected session. The terminal is
// only torn down on switching AWAY from it — closing a /pty detaches this client
// alone and never kills the tmux, so re-entering the terminal view just re-attaches.
function applySessionView(sessionId) {
  const view = viewForSession(sessionId);
  const termWrap = document.getElementById('term-wrap');
  if (view === 'chat') {
    termWrap.hidden = true;
    closeTerminal();
    chatView.mount(sessionId);
  } else {
    chatView.unmount();
    termWrap.hidden = false;
    const s = latestSessions.find((x) => x.sessionId === sessionId);
    if (s) openTerminal(s);
  }
}
```

Call `applySessionView(sessionId)` from `selectSession` (public/app.js:2451) where `openTerminal` is called today, and construct the controller once at startup:

```js
const chatView = initChatView({
  send,
  onSubagentClick: (sid, subagentId) => openSubagentModal(sid, subagentId),
  onOpenDiff: (sid) => openDiffPanel(sid),
});
```

- [ ] **Step 5: Route the reply and the status**

In the control-WS `onmessage` dispatch, beside the `subagent-detail` case:

```js
    if (msg.type === 'chat') { chatView.onChatReply(msg); return; }
```

And in `renderPanel`, after computing `stateClass`:

```js
  if (view === 'chat') chatView.setStatus(displayStatus(s));
```

- [ ] **Step 6: Add the styles**

Append to `public/styles.css`, using existing semantic variables only — no hex, and it must read correctly in both themes:

```css
/* Chat view — the segmented toggle borrows .diff-mode-btn's shape deliberately:
   same job (two views of one thing), so it should look like the same control. */
.chat-seg { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.chat-seg-btn { font: inherit; font-size: 11.5px; padding: 3px 9px; border: 0; cursor: pointer;
  background: transparent; color: var(--text-dim); }
.chat-seg-btn.on { background: var(--accent-soft); color: var(--text); font-weight: 600; }

#chat-wrap { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.chat-stream { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 9px; }
.chat-user { background: var(--surface-2); border-radius: 13px; padding: 7px 11px;
  margin-left: auto; max-width: 80%; width: fit-content; white-space: pre-wrap; }
.chat-prose > :first-child { margin-top: 0; }
.chat-turn-foot { display: flex; gap: 10px; font-size: 11px; color: var(--text-dim); }
.chat-thinking-label, .chat-activity-label { font-size: 11.5px; }
.chat-thinking-body[data-collapsed="1"], .chat-activity-body[data-collapsed="1"] { display: none; }
.chat-activity-chip { display: flex; align-items: center; gap: 8px; font: inherit;
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 11px;
  background: transparent; color: var(--text); cursor: pointer; width: fit-content; }
.chat-tool-row { font-size: 11.5px; color: var(--text-dim); }
.chat-tool-target, .chat-tool-output { font-family: var(--mono); }
.chat-tool-output { white-space: pre-wrap; max-height: 220px; overflow: auto; }
.chat-tool-output[data-truncated="1"]::after { content: ' …truncated'; color: var(--text-dim); }
.chat-tool-row[data-failed="1"] .chat-tool-name { color: var(--danger); }
.chat-subagent { border: 1px solid var(--violet); background: var(--violet-soft);
  border-radius: 8px; padding: 6px 9px; font-size: 11.5px; cursor: pointer; }
.chat-notice { border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 11.5px; }
.chat-notice-bar { display: flex; align-items: center; gap: 9px; font-size: 11.5px;
  background: var(--warn-soft); border-top: 1px solid var(--warn); padding: 8px 11px; }
.chat-composer { border-top: 1px solid var(--border); padding: 9px 11px; }
.chat-box { display: flex; align-items: flex-end; gap: 8px;
  border: 1px solid var(--border); border-radius: 9px; padding: 7px 9px; }
.chat-box textarea { flex: 1; resize: none; border: 0; background: transparent;
  color: var(--text); font: inherit; max-height: 140px; }
.chat-hint, .chat-working { font-size: 10.5px; color: var(--text-dim); margin-top: 5px; }
```

Before writing these, confirm each variable name exists: `grep -n '\-\-border\|--surface-2\|--text-dim\|--accent-soft\|--violet\|--warn\|--danger\|--mono' public/styles.css | head -20`. Substitute the repo's actual names where they differ — do **not** introduce a new variable or a hex fallback.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "Add the Chat/Terminal toggle with a per-card-id override"
```

---

### Task 11: Composer send and interrupt

**Files:**
- Create: `server/control/handlers/interrupt.js`
- Create: `server/control/handlers/interrupt.test.js`
- Modify: `server/control/handlers/index.js`
- Modify: `public/chat-view.js`

**Interfaces:**
- Consumes: `sendKeys` from `server/tmux-scraper.js` (already exported); the existing `message` control type.
- Produces: control message type `'interrupt'`; handler export `interruptHandler`.

**Sending changes nothing about delivery.** The composer emits the existing `{ type: 'message', sessionId, text }`, which routes through `deliverMessage` and already handles live (paste into pane), dormant (wake, then deliver) and archived (refuse). This is the **human** path, which is deliberately *not* routed through the mailbox — the mailbox is peer-only. Do not change that here.

- [ ] **Step 1: Write the failing test**

```js
// server/control/handlers/interrupt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interruptHandler } from './interrupt.js';

function ctx({ tmux = 'cc_abc' } = {}) {
  const calls = [];
  return {
    calls,
    sessionFromGraph: () => ({ liveSessionId: 'live-1' }),
    tmuxFor: () => tmux,
    socketFor: () => 'sock',
    sendKeys: (name, keys, socket) => { calls.push({ name, keys, socket }); },
    reply: () => {},
  };
}

test('interrupt sends Escape to the session pane', async () => {
  const c = ctx();
  await interruptHandler.handler({ type: 'interrupt', sessionId: 'card-1' }, c);
  assert.deepEqual(c.calls, [{ name: 'cc_abc', keys: ['Escape'], socket: 'sock' }]);
});

test('interrupt on a session with no live pane is a no-op', async () => {
  const c = ctx({ tmux: null });
  await interruptHandler.handler({ type: 'interrupt', sessionId: 'card-1' }, c);
  assert.deepEqual(c.calls, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/control/handlers/interrupt.test.js`
Expected: FAIL — `Cannot find module './interrupt.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/control/handlers/interrupt.js
import { sendKeys as realSendKeys } from '../../tmux-scraper.js';

// Stop the current turn from the chat composer. Escape is what both TUIs read as
// "interrupt", so this stays agent-agnostic; if the two ever diverge, the key
// belongs in the agent adapter, not here. sendKeys is a ctx seam for tests.
export const interruptHandler = {
  type: 'interrupt',
  async handler(msg, ctx) {
    const sendKeys = ctx.sendKeys || realSendKeys;
    const target = ctx.tmuxFor?.(msg.sessionId);
    if (!target) return; // dormant or archived: nothing to interrupt
    await sendKeys(target, ['Escape'], ctx.socketFor?.(msg.sessionId) || '');
  },
};
```

Register it in `server/control/handlers/index.js` as in Task 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/control/handlers/interrupt.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire the composer**

Add to `initChatView`'s returned setup in `public/chat-view.js`, inside the factory body before the `return`:

```js
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const stopBtn = document.getElementById('chat-stop');
  const hint = document.getElementById('chat-hint');

  function submit() {
    const text = input.value.trim();
    if (!text || !sessionId) return;
    // The EXISTING human message path: live → paste into the pane, dormant →
    // wake and deliver, archived → refuse. Deliberately not the mailbox, which
    // is peer-only.
    send({ type: 'message', sessionId, text });
    input.value = '';
    input.style.height = 'auto';
  }

  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', () => sessionId && send({ type: 'interrupt', sessionId }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });
  hint.textContent = 'Enter sends · Shift+Enter newline';
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/control/handlers/interrupt.js server/control/handlers/interrupt.test.js server/control/handlers/index.js public/chat-view.js
git commit -m "Wire the chat composer to the existing message path, with an interrupt"
```

---

### Task 12: The needs-you handoff

**Files:**
- Modify: `public/chat-view.js`
- Modify: `public/app.js` (the `setStatus` call site from Task 10)

**Interfaces:**
- Consumes: `setStatus(status)` (Task 9), the `notice` events (Task 4).
- Produces: a `Terminal →` button inside `#chat-notice-bar` that switches the view, and a dimmed composer while blocked.

The hybrid: the sticky bar answers "is it blocked *now*" and needs **no new detection** — it reads `status === 'needs-you'` off the graph the client already receives. The resolved row answers "what happened" and arrives from the transcript as a `notice` event once answered. Codex has no needs-you (pane-scraped status cannot produce it), so the bar simply never appears there; the `Terminal` toggle is always one click away, which is unchanged from today where the terminal is the only option.

- [ ] **Step 1: Extend `setStatus` with the handoff button and composer dimming**

Replace the `setStatus` body in `public/chat-view.js`:

```js
    setStatus(status) {
      const bar = document.getElementById('chat-notice-bar');
      const stop = document.getElementById('chat-stop');
      const box = document.querySelector('.chat-box');
      const blocked = status === 'needs-you';
      bar.hidden = !blocked;
      bar.textContent = '';
      if (blocked) {
        const msg = document.createElement('span');
        msg.textContent = 'Waiting on you — this prompt only exists in the terminal.';
        bar.appendChild(msg);
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'chat-notice-go';
        go.textContent = 'Terminal →';
        go.addEventListener('click', () => onGoTerminal?.(sessionId));
        bar.appendChild(go);
      }
      // Dim rather than disable: a prompt typed while blocked would land in the
      // permission dialog, not the conversation, so the composer must visibly
      // stop inviting input until the dialog is answered.
      box?.setAttribute('data-blocked', blocked ? '1' : '0');
      input.placeholder = blocked ? 'Answer the prompt in the terminal first…' : 'Send a prompt…';
      input.disabled = blocked;
      stop.hidden = status !== 'working';
    },
```

Add `onGoTerminal` to `initChatView`'s destructured options.

- [ ] **Step 2: Pass the handoff callback from app.js**

Extend the `initChatView` call from Task 10:

```js
  onGoTerminal: (sid) => { setSessionView(sid, 'terminal'); applySessionView(sid); renderPanel(sid); },
```

- [ ] **Step 3: Style the blocked state**

Append to `public/styles.css`:

```css
.chat-box[data-blocked="1"] { opacity: .55; }
.chat-notice-go { margin-left: auto; font: inherit; font-size: 11.5px; font-weight: 600;
  border: 1px solid var(--warn); border-radius: 6px; padding: 3px 9px;
  background: transparent; color: var(--text); cursor: pointer; white-space: nowrap; }
```

- [ ] **Step 4: Verify syntax and run the suite**

Run: `node --check public/chat-view.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/chat-view.js public/app.js public/styles.css
git commit -m "Add the needs-you sticky bar and terminal handoff"
```

---

### Task 13: Document the invariants and verify in a real board

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: no code.

Three facts must be written where the next reader will look, because all three look like bugs to someone who knows the existing invariants and would "fix" them.

- [ ] **Step 1: Add the CLAUDE.md entries**

Under *Invariants & footguns*, add a bullet covering:
- **The chat view's read path must not apply the fork bound and must not price anything.** A fork replaying parent history is correct for *reading*; `usageSince` bounds spend only. And three cost scanners already have to agree on `iterations[]`/advisor/fork rules — the chat path deliberately shows model and tokens only so it never becomes a fourth. `subagent.usd` is forwarded from `transcript-reader.js`, not recomputed.
- **Codex `function_call` pairs on `call_id`, never `id`.** Both exist (`fc_…` and `call_id: call_…`); the output carries only `call_id`. Pairing on `id` does not throw — it silently renders a timeline with no tool outputs. Codex `reasoning` is `encrypted_content` with `summary: []`, so Codex thinking is a presence marker and can never have text.
- **`server/chat-events.js` is a leaf and must stay one**, and it deliberately duplicates `search/extract.js`'s *shape* while keeping the tool calls that module drops — opposite goals, do not merge them.

- [ ] **Step 2: Add a README line**

One sentence in the features list noting the sidebar's Chat/Terminal toggle and that chat reads dormant and archived sessions the terminal cannot show.

- [ ] **Step 3: Run the mandated UI verification**

The repo requires the `wrangler-verify-ui` skill for `public/` and session-lifecycle changes. Invoke it and work through what it asks.

- [ ] **Step 4: Drive a real isolated instance**

Use the `run-dev` skill to start an isolated dev instance (a fresh `AW_DATA_DIR` — never point it at the live board) and confirm by hand:
1. A live Claude session renders prose, collapses a tool run into one chip, and expands it.
2. The toggle switches to the terminal and back; the terminal still attaches after a round trip (closing a `/pty` detaches this client only and must not kill the tmux).
3. A dormant session renders its conversation with the "sending will wake it" hint.
4. A Codex session renders messages and tool calls, with a text-free thinking marker.
5. Sending from the composer reaches the agent; `Stop` interrupts a working turn.
6. A permission prompt raises the sticky bar, and `Terminal →` jumps to it.
7. Both themes read correctly; nothing is unstyled or invisible in light mode.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document the chat view's deliberately-inapplicable invariants"
```

---

## Self-review

**Spec coverage.** Every spec section maps to a task: event model and per-agent mapping → Tasks 1–4; delivery, both payload bounds and seam correctness → Task 5; the preference and its per-session override → Tasks 6 and 10; the three client files → Tasks 7–9; composer and interrupt → Task 11; the needs-you hybrid → Task 12; Codex gaps and the two inapplicable invariants → Task 13. Testing requirements are distributed into the task that produces the code under test, per the right-sizing rule.

**One deliberate refinement of the spec, flagged for the reviewer.** The spec's event table implies `subagent` events carry `status` and `calls`. Task 4 emits the *spawn point* only (`id`, `name`, `ts`), with status and cost read by the client from the graph's existing `s.subAgents`. This is strictly better: it avoids re-implementing the `subagents/`-dir-versus-inline discriminator that `transcript-reader.js` already owns, which is the exact rule whose violation makes every modern sub-agent double-count. The transcript supplies chronological position; the existing analysis supplies state.

**Two things intentionally deferred within Task 5.** The spec's "load earlier" affordance is only partially built: the handler returns `more: true` whenever the chosen window starts above byte 0 — the initial window is now sized by *event count* (~200 events, doubling backwards from 256 KB up to an 8 MB ceiling), because transcript bytes are dominated by tool output and a flat byte window showed a median of 2 turns out of 6 — but nothing reads that flag, there is no client control, and — contrary to an earlier draft of this note — the protocol supports only a *forward* `sinceOffset` read. There is no backwards request at all yet. Wiring "load earlier" needs BOTH a backwards read (older bytes, before the window start) and a client control that calls it; naively wiring a button to `sinceOffset: 0` would use the existing forward read and APPEND the entire history *below* the current tail, not prepend it above — worse than doing nothing. Build both pieces together when the first long transcript makes this necessary. Flagged rather than silently dropped.

**Type consistency.** `createChatScanner`/`scanChatText`/`MAX_TOOL_TEXT` (Tasks 1–4) are consumed under those exact names in Task 5. `groupChatEvents`/`activityLabel` (Task 7) and `createChatDom`/`activityTitle` (Task 8) match their Task 9 call sites. `viewForSession`/`setSessionView`/`applySessionView` (Task 10) match the Task 12 handoff. Event `kind` values (`user`/`assistant`/`thinking`/`tool`/`subagent`/`notice`) are consistent between the scanner, the grouper's `item.type`, and `itemNode`'s dispatch. Control types `chat`, `set-chat-view-default`, `interrupt` are each registered in the task that creates them.
