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

test('oversized tool input (e.g. a Write body) is truncated and flagged, target stays uncapped', () => {
  const bigContent = 'y'.repeat(MAX_TOOL_TEXT + 500);
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_4', name: 'Write', input: { file_path: '/big.js', content: bigContent, overwrite: true } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_4', content: 'ok' },
    ] } },
  );
  const ev = scanChatText(text, 'claude').events[0];
  assert.equal(ev.input.content.length, MAX_TOOL_TEXT);
  assert.equal(ev.truncated, true);
  assert.equal(ev.target, '/big.js');
  assert.equal(ev.input.overwrite, true);
});

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

test('codex: an assistant message takes its model from the preceding turn_context', () => {
  const text = codexLines(
    { type: 'turn_context', timestamp: '2026-08-14T10:00:00.000Z', payload: { turn_id: 't1', model: 'gpt-5.5', cwd: '/repo' } },
    { type: 'response_item', timestamp: '2026-08-14T10:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] } },
  );
  const { events } = scanChatText(text, 'codex');
  assert.deepEqual(events.map((e) => e.kind), ['assistant'], 'turn_context itself emits no event');
  assert.equal(events[0].model, 'gpt-5.5');
});
