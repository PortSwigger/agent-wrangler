import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanChatText, MAX_TOOL_TEXT } from './chat-events.js';

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
  const text = '{"type":"user","timestamp":"2026-08-14T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n{"type":"user","message":{"role":"user","content":"hi';
  assert.deepEqual(scanChatText(text, 'claude').events.map((e) => e.kind), ['user']);
});

test('claude: model is carried forward to later assistant messages that omit it', () => {
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:04.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'First.' }] } },
    { type: 'assistant', timestamp: '2026-08-14T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Second.' }] } },
  );
  const { events } = scanChatText(text, 'claude');
  assert.deepEqual(events.map((e) => e.model), ['claude-opus-5', 'claude-opus-5']);
});

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
