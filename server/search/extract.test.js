import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLine, mightCarryText } from './extract.js';
import { ROLE_USER, ROLE_ASSISTANT } from './records.js';

const claude = (o) => JSON.stringify(o);

test('a typed prompt and a text answer are indexed', () => {
  const user = extractLine(claude({
    type: 'user', message: { role: 'user', content: 'how do I rebase this' },
    timestamp: '2026-08-01T10:00:00.000Z', sessionId: 'sid', cwd: '/repo',
  }), 'claude');
  assert.equal(user.record.role, ROLE_USER);
  assert.equal(user.record.text, 'how do I rebase this');
  assert.equal(user.record.tsSec, Math.floor(Date.parse('2026-08-01T10:00:00.000Z') / 1000));
  assert.equal(user.meta.cwd, '/repo');

  const asst = extractLine(claude({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Run git rebase.' }] },
    timestamp: '2026-08-01T10:00:05.000Z',
  }), 'claude');
  assert.equal(asst.record.role, ROLE_ASSISTANT);
  assert.equal(asst.record.text, 'Run git rebase.');
});

test('tool traffic is not conversation', () => {
  // A tool_result wears the user role but is command output.
  const toolResult = extractLine(claude({
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '120 files changed' }] },
  }), 'claude');
  assert.equal(toolResult.record, undefined);
  // An assistant turn that only calls a tool has no text to search.
  const toolUse = extractLine(claude({
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  }), 'claude');
  assert.equal(toolUse.record, undefined);
});

test('thinking blocks are the scratchpad, not the response', () => {
  const got = extractLine(claude({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret plan' }, { type: 'text', text: 'Done.' }] },
  }), 'claude');
  assert.equal(got.record.text, 'Done.');
});

test('injected turns are skipped', () => {
  assert.equal(extractLine(claude({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: …' } }), 'claude').record, undefined);
  const codexEnv = extractLine(JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] },
  }), 'codex');
  assert.equal(codexEnv.record, undefined);
});

test('doc metadata is picked up off non-message lines', () => {
  const title = extractLine(claude({ type: 'ai-title', aiTitle: 'Rebase help', sessionId: 'sid' }), 'claude');
  assert.equal(title.meta.title, 'Rebase help');
  const meta = extractLine(JSON.stringify({
    type: 'session_meta', payload: { id: 'abc', cwd: '/repo', git: { branch: 'main' } },
  }), 'codex');
  assert.deepEqual(meta.meta, { id: 'abc', cwd: '/repo', branch: 'main' });
});

test('codex indexes response_item messages, not their event_msg duplicates', () => {
  const item = extractLine(JSON.stringify({
    timestamp: '2026-08-01T10:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Patched the send path.' }] },
  }), 'codex');
  assert.equal(item.record.text, 'Patched the send path.');
  // The same text also arrives as an event_msg; indexing both would double every
  // Codex message.
  const dup = extractLine(JSON.stringify({
    type: 'event_msg', payload: { type: 'agent_message', message: 'Patched the send path.' },
  }), 'codex');
  assert.equal(dup, null);
});

test('the pre-parse gate rejects lines that cannot contribute', () => {
  assert.equal(mightCarryText('{"type":"file-history-snapshot","snapshot":{}}', 'claude'), false);
  assert.equal(mightCarryText('{"message":{"role":"assistant"}}', 'claude'), true);
  assert.equal(mightCarryText('{"type":"event_msg","payload":{"type":"token_count"}}', 'codex'), false);
  assert.equal(extractLine('{not json', 'claude'), null);
  assert.equal(extractLine('', 'claude'), null);
});
