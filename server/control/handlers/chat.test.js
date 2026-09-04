import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatHandler, WINDOW_BYTES, TARGET_EVENTS, MAX_INITIAL_BYTES } from './chat.js';

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

const toolUseLine = (id, name, input, ts) => ({
  type: 'assistant',
  timestamp: ts,
  message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id, name, input }] },
});

const toolResultLine = (id, ts, output = 'ok') => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] },
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

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

test('chat: Codex sessions are refused before any transcript read', async () => {
  const c = ctx(null, { liveSessionId: 'live-1', agent: 'codex' });
  c.findTranscript = async () => { throw new Error('must not read Codex chat'); };
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', token: 4 }, c);
  assert.deepEqual(c.sent[0].events, []);
  assert.equal(c.sent[0].offset, 0);
  assert.equal(c.sent[0].token, 4);
});

test('chat: echoes the client token verbatim on a normal reply', async () => {
  // The client (chat-view.js) compares this against its own current generation
  // to tell a reply from an earlier mount era apart from the current one, since
  // concurrent chat requests are not serialized and can complete out of order —
  // sessionId alone can't distinguish two eras of the same session id.
  const file = await tmpTranscript([userLine('one', '2026-08-14T10:00:00.000Z')]);
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', token: 7 }, c);
  assert.equal(c.sent[0].token, 7);
});

test('chat: echoes the client token on the missing-transcript early return too', async () => {
  // Every reply path must carry it — a path that silently drops the token would
  // make the client permanently ignore replies for that session, since a token
  // of `undefined` never matches a real generation.
  const c = ctx(null);
  c.findTranscript = async () => null;
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', token: 3 }, c);
  assert.equal(c.sent[0].token, 3);
});

test('chat: a windowed read whose boundary falls mid-multi-byte-char still returns aligned offsets', async () => {
  // Every line carries multi-byte characters, so the WINDOW_BYTES cut almost
  // certainly lands inside one. The invariant under test: whatever the window
  // does, the returned offset must be a real line boundary — so a follow-up poll
  // from it parses cleanly and loses nothing.
  const many = Array.from({ length: 4000 }, (_, i) => userLine(`msg ${i} ⏺ ${'…箱'.repeat(15)}`, '2026-08-14T10:00:00.000Z'));
  const file = await tmpTranscript(many);
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const first = c.sent[0];
  assert.equal(first.more, true);
  // The offset must sit immediately after a newline, or the next poll starts mid-line.
  const bytes = fs.readFileSync(file);
  assert.ok(first.offset === bytes.length || bytes[first.offset - 1] === 0x0A,
    'returned offset is not a line boundary — later polls would drop an event');
  // No mojibake: a mangled boundary shows up as U+FFFD in the first event's text.
  assert.ok(!first.events[0].text.includes('�'), 'window boundary corrupted the first decoded line');
  // And a follow-up poll from that offset parses cleanly.
  await fsp.appendFile(file, JSON.stringify(userLine('tail ⏺', '2026-08-14T10:00:01.000Z')) + '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: first.offset }, c);
  assert.deepEqual(c.sent[1].events.map((e) => e.text), ['tail ⏺']);
});

test('chat: a windowed read with zero newlines widens to the whole file instead of jumping to EOF', async () => {
  // A single line with no newline anywhere in it that is bigger than WINDOW_BYTES
  // on its own (e.g. a still-streaming huge tool Read). The old behaviour replied
  // offset: size, which is a real line boundary in form only — the next poll would
  // start past this content and never see it again even once it terminates.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-chat-'));
  const file = path.join(dir, 'conv.jsonl');
  const content = 'a'.repeat(WINDOW_BYTES + 100); // no '\n' at all, no trailing newline
  await fsp.writeFile(file, content);
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const reply = c.sent[0];
  assert.deepEqual(reply.events, []);
  // The widened (non-windowed) read finds no newline anywhere either, so it must
  // fall through to the "no complete line yet" branch, resuming from 0 — NOT the
  // old offset: size shortcut, which would have discarded the line permanently.
  assert.equal(reply.offset, 0, 'must resume from the true start, not jump past the unterminated line');
  assert.equal(reply.more, false, 'no window boundary survives the widen — everything before offset 0 is nothing');

  // Once the line is completed, a poll from that offset parses it — proving
  // nothing was lost, only deferred.
  await fsp.appendFile(file, '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: reply.offset }, c);
  // 'a'.repeat(...) alone is not valid JSON, so the scanner correctly discards
  // it — the point of this assertion is just that the handler did not throw and
  // did advance past the now-complete line rather than looping forever.
  assert.deepEqual(c.sent[1].events, []);
  assert.equal(c.sent[1].offset, content.length + 1);
});

test('chat: a windowed read whose only in-window newline is the one being skipped defers the trailing incomplete line rather than dropping it', async () => {
  // Construct a file where the WINDOW_BYTES tail contains exactly one newline —
  // the one belonging to a short header line — immediately followed by a large,
  // not-yet-terminated line. This exercises the `lastNl < from` branch (distinct
  // from the zero-newline widen case above): the window DOES find a boundary to
  // skip past, but nothing complete follows it yet.
  const ts = '2026-08-14T10:00:00.000Z';
  const text = 'x'.repeat(WINDOW_BYTES); // guarantees fullLine is far longer than WINDOW_BYTES
  const fullLine = JSON.stringify(userLine(text, ts));
  const header = 'h\n';
  const T = WINDOW_BYTES - 1; // sized so the window boundary lands 1 byte before header's own newline
  const partial = fullLine.slice(0, T);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-chat-'));
  const file = path.join(dir, 'conv.jsonl');
  await fsp.writeFile(file, header + partial); // deliberately no trailing newline on the tail line
  const c = ctx(file);
  // Pin the initial read to a single WINDOW_BYTES attempt — the shape production
  // hits when the event-count widen runs into MAX_INITIAL_BYTES. Without this the
  // widen would reach byte 0 (this fixture is only ~WINDOW_BYTES long) and the
  // final attempt would take the complete-line path instead, leaving this branch
  // — a window that finds a boundary to skip but nothing complete after it —
  // untested. The widen itself is covered by the event-count tests below.
  c.maxInitialBytes = WINDOW_BYTES;

  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const first = c.sent[0];
  assert.deepEqual(first.events, [], 'nothing parseable yet — the only line in view is incomplete');
  assert.equal(first.more, true);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes[first.offset - 1], 0x0a, 'offset must land right after the header line, not mid-line');

  // Complete the line and poll again from the returned offset: it must parse
  // exactly once, proving the branch deferred the event rather than dropping it.
  const remainder = fullLine.slice(T);
  await fsp.appendFile(file, remainder + '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: first.offset }, c);
  assert.deepEqual(c.sent[1].events.map((e) => e.text), [text]);
});

test('chat: a tool_use in one poll and its tool_result in the next still pairs into a tool event (regression)', async () => {
  // Reproduces the real production shape: an assistant's tool_use line and its
  // tool_result land in separate 2s poll windows because the tool takes time to
  // run. A scanner built fresh per request (the pre-fix behaviour) has no memory
  // of the open tool_use by the time the second poll arrives, so the tool_result
  // finds nothing to pair with and the whole tool event is silently dropped.
  const file = await tmpTranscript([toolUseLine('call-1', 'Bash', { command: 'npm test' }, '2026-08-14T10:00:00.000Z')]);
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const first = c.sent[0];
  assert.deepEqual(first.pending, { name: 'Bash', target: 'npm test' }, 'the tool_use is still open after poll 1');

  await fsp.appendFile(file, JSON.stringify(toolResultLine('call-1', '2026-08-14T10:00:05.000Z')) + '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: first.offset }, c);
  const second = c.sent[1];
  const toolEvent = second.events.find((e) => e.kind === 'tool');
  assert.ok(toolEvent, 'the tool_result must pair with the tool_use seen in the PREVIOUS poll, not be lost');
  assert.equal(toolEvent.name, 'Bash');
  assert.equal(toolEvent.target, 'npm test');
});

test(
  'chat: a transcript that becomes unreadable between stat and open replies with an empty stream, not a throw',
  { skip: isRoot ? 'chmod has no effect running as root' : false },
  async () => {
    const file = await tmpTranscript([userLine('one', '2026-08-14T10:00:00.000Z')]);
    fs.chmodSync(file, 0o000);
    try {
      const c = ctx(file);
      await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
      assert.deepEqual(c.sent[0].events, []);
      assert.equal(c.sent[0].offset, 0);
    } finally {
      fs.chmodSync(file, 0o644);
    }
  }
);

// ---------------------------------------------------------------------------
// Event-count windowing. Each of these pins the OLD behaviour in the same test
// by injecting maxInitialBytes: WINDOW_BYTES, which stops the widen after the
// first 256 KB attempt — so the assertions state the before/after directly
// rather than describing it in a comment.
// ---------------------------------------------------------------------------

const bigUserTurns = (n, padChars, tsBase = '2026-08-14T10:00:00.000Z') =>
  Array.from({ length: n }, (_, i) => userLine(`msg ${i} ${'p'.repeat(padChars)}`, tsBase));

test('chat: the initial window is sized by event count, not bytes', async () => {
  // 300 modest turns, ~900 KB in total: a flat 256 KB window shows barely a
  // quarter of them. The event target keeps doubling backwards until the whole
  // conversation is in view.
  const many = bigUserTurns(300, 3000);
  const file = await tmpTranscript(many);
  const size = fs.statSync(file).size;
  assert.ok(size > 3 * WINDOW_BYTES, 'fixture must be several windows long');

  const old = ctx(file);
  old.maxInitialBytes = WINDOW_BYTES; // the pre-fix, byte-only behaviour
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, old);
  const byteWindow = old.sent[0].events.length;
  assert.ok(byteWindow < TARGET_EVENTS, `a 256 KB slice yields only ${byteWindow} events`);

  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const reply = c.sent[0];
  assert.equal(reply.events.length, many.length, 'every turn is visible — the file is smaller than the ceiling');
  assert.ok(reply.events.length >= TARGET_EVENTS, 'at least the event target is in view');
  assert.ok(reply.events.length > byteWindow * 3, 'materially more than the byte window gave');
  assert.equal(reply.more, false, 'the widen reached byte 0, so nothing is older than this window');
  assert.equal(reply.offset, size, 'a complete file ends on a line boundary at EOF');
});

test('chat: a tool-output-heavy tail shows far more user turns than a byte window would', async () => {
  // The actual bug: transcript bytes are tool output, not conversation. Each turn
  // here is one small user line plus a tool call whose result is ~40 KB, so a
  // 256 KB window spans only a handful of turns however many the session has.
  const lines = [];
  for (let i = 0; i < 12; i += 1) {
    const ts = `2026-08-14T10:${String(i).padStart(2, '0')}:00.000Z`;
    lines.push(userLine(`question ${i}`, ts));
    lines.push(toolUseLine(`call-${i}`, 'Read', { file_path: `/repo/file-${i}.js` }, ts));
    lines.push(toolResultLine(`call-${i}`, ts, 'L'.repeat(40 * 1024)));
  }
  const file = await tmpTranscript(lines);
  assert.ok(fs.statSync(file).size > WINDOW_BYTES * 1.5, 'fixture must exceed the old window several times over');
  const users = (r) => r.events.filter((e) => e.kind === 'user').length;

  const old = ctx(file);
  old.maxInitialBytes = WINDOW_BYTES;
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, old);
  const before = users(old.sent[0]);

  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const after = users(c.sent[0]);

  assert.ok(before <= 7, `a 256 KB tail of tool output shows only ${before} of 12 turns`);
  assert.equal(after, 12, 'the event target pulls the whole conversation into view');
  assert.ok(after > before, 'the fix must strictly increase visible conversation');
});

test('chat: a single enormous turn far bigger than the byte window is not lost', async () => {
  // The pathological case: one turn whose own line dwarfs WINDOW_BYTES. Its only
  // in-window newline is the file's final byte, so the byte window skipped past
  // the entire line and replied with nothing at all — 0 turns visible, forever.
  const text = 'z'.repeat(400 * 1024);
  const file = await tmpTranscript([userLine(text, '2026-08-14T10:00:00.000Z')]);
  const size = fs.statSync(file).size;

  const old = ctx(file);
  old.maxInitialBytes = WINDOW_BYTES;
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, old);
  assert.deepEqual(old.sent[0].events, [], 'the byte window showed this session nothing');

  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const reply = c.sent[0];
  assert.equal(reply.events.length, 1, 'the widen reaches back far enough to see the one turn');
  assert.equal(reply.events[0].text, text);
  assert.equal(reply.offset, size);
  assert.equal(reply.more, false);
});

test('chat: a transcript that fits entirely is fully visible with more:false', async () => {
  const many = bigUserTurns(5, 10);
  const file = await tmpTranscript(many);
  assert.ok(fs.statSync(file).size < WINDOW_BYTES, 'fixture must fit inside the first attempt');
  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const reply = c.sent[0];
  assert.equal(reply.events.length, many.length);
  assert.equal(reply.more, false, 'nothing above byte 0 to fetch');
  assert.equal(reply.offset, fs.statSync(file).size);
});

test('chat: the byte ceiling stops the widen, returning promptly with more:true', async () => {
  // Injects a small ceiling rather than writing an 8 MB fixture — the production
  // constant is untouched (asserted below). 20 turns of ~60 KB each: the ceiling
  // is hit long before TARGET_EVENTS, so the reply is a bounded tail, not the file.
  assert.equal(MAX_INITIAL_BYTES, 8 * 1024 * 1024, 'production ceiling must not be weakened');
  const many = bigUserTurns(20, 60 * 1024);
  const file = await tmpTranscript(many);
  const size = fs.statSync(file).size;
  const ceiling = 512 * 1024;
  assert.ok(size > ceiling * 2, 'fixture must be well past the injected ceiling');

  const c = ctx(file);
  c.maxInitialBytes = ceiling;
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const reply = c.sent[0];
  assert.ok(reply.events.length > 0, 'a capped read still ships what it found');
  assert.ok(reply.events.length < TARGET_EVENTS, 'the ceiling, not the event target, is what stopped it');
  assert.ok(reply.events.length < many.length, 'and it did NOT read the whole file');
  assert.equal(reply.more, true, 'older events exist above this window');
  const bytes = fs.readFileSync(file);
  assert.ok(reply.offset === size || bytes[reply.offset - 1] === 0x0A, 'offset must be a real line boundary');
  assert.equal(reply.events.at(-1).text, many.at(-1).message.content, 'the window keeps the NEWEST events');
});

test('chat: only the final attempt of a widened read is cached, so the next poll still pairs its tool call', async () => {
  // Invariant: each attempt scans a larger range with a FRESH scanner, and exactly
  // one scanner — the chosen attempt's, keyed on the offset actually returned — is
  // cached. Get that wrong and a follow-up poll either reuses a scanner built from
  // a range it isn't resuming, or gets none and drops the open tool call.
  const lines = [];
  for (let i = 0; i < 10; i += 1) {
    const ts = `2026-08-14T10:${String(i).padStart(2, '0')}:00.000Z`;
    lines.push(userLine(`question ${i}`, ts));
    lines.push(toolUseLine(`call-${i}`, 'Read', { file_path: `/repo/file-${i}.js` }, ts));
    lines.push(toolResultLine(`call-${i}`, ts, 'L'.repeat(40 * 1024)));
  }
  lines.push(toolUseLine('call-open', 'Bash', { command: 'npm test' }, '2026-08-14T10:30:00.000Z'));
  const file = await tmpTranscript(lines);
  assert.ok(fs.statSync(file).size > WINDOW_BYTES, 'the read must actually widen for this to mean anything');

  const c = ctx(file);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const first = c.sent[0];
  assert.equal(first.events.filter((e) => e.kind === 'user').length, 10, 'the widen ran');
  assert.deepEqual(first.pending, { name: 'Bash', target: 'npm test' }, 'the trailing tool_use is open');
  assert.equal(first.events.filter((e) => e.kind === 'tool').length, 10, 'each closed call paired exactly once, not twice');

  await fsp.appendFile(file, JSON.stringify(toolResultLine('call-open', '2026-08-14T10:30:05.000Z')) + '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: first.offset }, c);
  const paired = c.sent[1].events.find((e) => e.kind === 'tool');
  assert.ok(paired, 'the cached scanner from the CHOSEN attempt must still hold the open call');
  assert.equal(paired.target, 'npm test');
});

// --- suggested next prompt (scraped off the pane, see ghost-suggestion.js) ---

const E = '\x1b';
const paneWithSuggestion = `${E}[39m❯ ${E}[2mpoint 5${E}[0m`;

function ctxWithPane(file, node, pane) {
  const c = ctx(file, node);
  c.capturePaneStyled = async (...args) => { c.captured = args; return pane; };
  return c;
}

test('chat: a live Claude session reports the pane suggestion', async () => {
  const file = await tmpTranscript([userLine('hi', '2026-08-14T10:00:00.000Z')]);
  const c = ctxWithPane(file, { liveSessionId: 'live-1', agent: 'claude', tmux: 'cc_a', socket: 'sock' }, paneWithSuggestion);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(c.sent[0].suggestion, 'point 5');
  assert.deepEqual(c.captured, ['cc_a', 6, 'sock'], 'targets the session pane, few lines');
});

// A suggestion is live-only state; a dormant card has no pane to read.
test('chat: a session with no tmux never captures a pane', async () => {
  const file = await tmpTranscript([userLine('hi', '2026-08-14T10:00:00.000Z')]);
  const c = ctxWithPane(file, { liveSessionId: 'live-1', agent: 'claude', tmux: null }, paneWithSuggestion);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(c.sent[0].suggestion, null);
  assert.equal(c.captured, undefined);
});

// Codex's composer is a different TUI; guessing at it is the wrong-suggestion
// failure the parser exists to avoid.
test('chat: codex is excluded from the pane scrape entirely', async () => {
  const file = await tmpTranscript([userLine('hi', '2026-08-14T10:00:00.000Z')]);
  const c = ctxWithPane(file, { liveSessionId: 'live-1', agent: 'codex', tmux: 'cx_a' }, paneWithSuggestion);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(c.sent[0].suggestion, null);
  assert.equal(c.captured, undefined);
});

// The all-paths rule that already covers token and lastTs covers this too: a
// reply omitting it is indistinguishable from "no suggestion" to the client.
test('chat: a missing transcript still carries the suggestion field', async () => {
  const c = ctxWithPane(null, { liveSessionId: 'live-1', agent: 'claude', tmux: 'cc_a' }, paneWithSuggestion);
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(c.sent[0].suggestion, 'point 5', 'read before the transcript lookup, so it survives its failure');
});

// --- dormant sessions: the graph node has no liveSessionId to offer ---

// The regression this covers: a dormant node deliberately omits liveSessionId, so
// the handler fell back to the CARD id, found no transcript under that name and
// rendered an empty stream — breaking the one thing this view does that the
// terminal cannot.
test('chat: a dormant session resolves its conversation id from the entry', async () => {
  const file = await tmpTranscript([userLine('still here', '2026-08-14T10:00:00.000Z')]);
  const c = ctx(file, { agent: 'claude', dormant: true }); // node WITHOUT liveSessionId
  c.sessionManager = { entryFor: () => ({ liveSessionId: 'live-1', agent: 'claude' }) };
  let asked = null;
  c.findTranscript = async (id) => { asked = id; return file; };
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(asked, 'live-1', 'looked the transcript up by the conversation id, not the card id');
  assert.equal(c.sent[0].events.length, 1);
});

test('chat: the graph node still wins over the entry when it has one', async () => {
  const file = await tmpTranscript([userLine('hi', '2026-08-14T10:00:00.000Z')]);
  const c = ctx(file, { liveSessionId: 'from-graph', agent: 'claude' });
  c.sessionManager = { entryFor: () => ({ liveSessionId: 'from-entry' }) };
  let asked = null;
  c.findTranscript = async (id) => { asked = id; return file; };
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(asked, 'from-graph');
});

// Legacy pre-split entries have neither, and the card id IS the conversation id.
test('chat: falls back to the card id when neither source has one', async () => {
  const file = await tmpTranscript([userLine('legacy', '2026-08-14T10:00:00.000Z')]);
  const c = ctx(file, { agent: 'claude' });
  c.sessionManager = { entryFor: () => ({}) };
  let asked = null;
  c.findTranscript = async (id) => { asked = id; return file; };
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(asked, 'card-1');
});

// A dormant Codex session must still be recognised as Codex for event mapping.
test('chat: the agent falls back to the entry too', async () => {
  const file = await tmpTranscript([userLine('hi', '2026-08-14T10:00:00.000Z')]);
  const c = ctx(file, { dormant: true });
  c.sessionManager = { entryFor: () => ({ liveSessionId: 'live-1', agent: 'codex' }) };
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  // A Claude-shaped line yields nothing under the Codex mapper, which is how we
  // can tell the agent was read from the entry rather than defaulted to claude.
  assert.deepEqual(c.sent[0].events, []);
});

// —— Branch pruning / epoch ————————————————————————————————————————————————————
// A Claude transcript is a tree and a rewind leaves the abandoned turns in the
// file. An initial read prunes them; a follow-up poll can't (its events are
// already on the client), so it moves `epoch` and the view rebuilds. Each test
// uses its OWN conversation id — both the scanner cache and the epoch counter
// are module-level and keyed on it.
const uu = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n, parent, o) => ({ uuid: uu(n), parentUuid: parent == null ? null : uu(parent), ...o });
const saidAt = (n, parent, text) => at(n, parent, {
  type: 'assistant', timestamp: '2026-08-27T09:00:01.000Z',
  message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] },
});
const sayAt = (n, parent, text) => at(n, parent, {
  type: 'user', timestamp: '2026-08-27T09:00:00.000Z', message: { role: 'user', content: text },
});

test('chat: the initial read drops the branch a rewind abandoned', async () => {
  const file = await tmpTranscript([
    sayAt(1, null, 'first prompt'),
    saidAt(2, 1, 'first answer'),
    sayAt(3, 2, 'abandoned prompt'),
    saidAt(4, 3, 'abandoned answer'),
    sayAt(5, 2, 'the prompt that stuck'),
    saidAt(6, 5, 'the answer on screen'),
  ]);
  const c = ctx(file, { liveSessionId: 'live-prune', agent: 'claude' });
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.deepEqual(c.sent[0].events.map((e) => e.text), ['first prompt', 'first answer', 'the prompt that stuck', 'the answer on screen']);
});

test('chat: every reply carries an epoch, including the early returns', async () => {
  // Same all-paths rule as `token`: a reply that omits it reads to the client as
  // epoch 0, which against a conversation whose counter has moved rebuilds the
  // stream on every single poll.
  const file = await tmpTranscript([userLine('one', '2026-08-27T10:00:00.000Z')]);
  const c = ctx(file, { liveSessionId: 'live-epoch-paths', agent: 'claude' });
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(c.sent[0].epoch, 0);
  const missing = ctx(null, { liveSessionId: 'live-epoch-paths', agent: 'claude' });
  missing.findTranscript = async () => null;
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, missing);
  assert.equal(missing.sent[0].epoch, 0, 'the missing-transcript early return carries it too');
});

test('chat: a rewind appended after the first read moves the epoch', async () => {
  const file = await tmpTranscript([
    sayAt(1, null, 'first prompt'),
    saidAt(2, 1, 'first answer'),
    sayAt(3, 2, 'the prompt on screen'),
    saidAt(4, 3, 'the answer on screen'),
  ]);
  const c = ctx(file, { liveSessionId: 'live-rewind', agent: 'claude' });
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  const first = c.sent[0];
  assert.deepEqual(first.events.map((e) => e.text), ['first prompt', 'first answer', 'the prompt on screen', 'the answer on screen']);
  // The reader backtracks and asks again: a sibling of prompt 3.
  await fsp.appendFile(file, JSON.stringify(sayAt(5, 2, 'asked again')) + '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: first.offset }, c);
  assert.equal(c.sent[1].epoch, first.epoch + 1, 'the client is told to rebuild rather than append');
  // And the rebuild's own read — no sinceOffset — comes back pruned, at the new epoch.
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  assert.equal(c.sent[2].epoch, first.epoch + 1, 'stable once reported, or the view rebuilds every poll');
  assert.deepEqual(c.sent[2].events.map((e) => e.text), ['first prompt', 'first answer', 'asked again']);
});

test('chat: an ordinary follow-up poll leaves the epoch alone', async () => {
  const file = await tmpTranscript([sayAt(1, null, 'first prompt'), saidAt(2, 1, 'first answer')]);
  const c = ctx(file, { liveSessionId: 'live-no-rewind', agent: 'claude' });
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1' }, c);
  await fsp.appendFile(file, JSON.stringify(sayAt(3, 2, 'next prompt')) + '\n');
  await chatHandler.handler({ type: 'chat', sessionId: 'card-1', sinceOffset: c.sent[0].offset }, c);
  assert.deepEqual(c.sent[1].events.map((e) => e.text), ['next prompt']);
  assert.equal(c.sent[1].epoch, c.sent[0].epoch);
});
