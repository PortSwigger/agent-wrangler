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
