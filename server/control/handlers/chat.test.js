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
