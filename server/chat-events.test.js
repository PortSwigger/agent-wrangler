import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanChatText, createChatScanner, mightCarryChat, recapOf, MAX_TOOL_TEXT } from './chat-events.js';

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

test('codex: oversized function_call arguments (e.g. an apply_patch body) are truncated and flagged', () => {
  const bigPatch = 'z'.repeat(MAX_TOOL_TEXT + 500);
  const text = codexLines(
    { type: 'response_item', timestamp: '2026-08-14T10:00:01.000Z', payload: {
      type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'apply_patch',
      arguments: JSON.stringify({ cmd: 'apply_patch', patch: bigPatch }),
    } },
    { type: 'response_item', timestamp: '2026-08-14T10:00:02.000Z', payload: {
      type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 0',
    } },
  );
  const ev = scanChatText(text, 'codex').events[0];
  assert.equal(ev.input.patch.length, MAX_TOOL_TEXT);
  assert.equal(ev.truncated, true);
});

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

test('an Edit tool event carries derived line counts', () => {
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_e1', name: 'Edit', input: { file_path: '/a.js', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_e1', content: 'ok' },
    ] } },
  );
  const ev = scanChatText(text, 'claude').events.find((e) => e.kind === 'tool');
  assert.equal(ev.adds, 4);
  assert.equal(ev.dels, 2);
});

test('a non-edit tool event carries no counts at all', () => {
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_r1', name: 'Read', input: { file_path: '/a.js' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_r1', content: 'body' },
    ] } },
  );
  const ev = scanChatText(text, 'claude').events.find((e) => e.kind === 'tool');
  assert.ok(!('adds' in ev), 'a read must not carry a misleading zero count');
  assert.ok(!('dels' in ev), 'a read must not carry a misleading zero count');
});

test('counts are derived from the UNCAPPED input, not the truncated copy', () => {
  // 3000 lines is well past MAX_TOOL_TEXT in characters, so a count taken from the
  // capped string would come out far too low.
  const content = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
  const text = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_w1', name: 'Write', input: { file_path: '/big.js', content } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_w1', content: 'written' },
    ] } },
  );
  const ev = scanChatText(text, 'claude').events.find((e) => e.kind === 'tool');
  assert.equal(ev.adds, 3000);
  assert.equal(ev.truncated, true, 'the shipped input is still capped');
});

test('apply_patch counts its real +/- lines and ignores file headers', () => {
  const patch = ['--- a/x.js', '+++ b/x.js', '@@ -1,2 +1,3 @@', ' keep', '-gone', '+new one', '+new two'].join('\n');
  const text = codexLines(
    { type: 'response_item', timestamp: '2026-08-14T10:00:01.000Z', payload: {
      type: 'function_call', id: 'fc_p', call_id: 'call_p', name: 'apply_patch',
      arguments: JSON.stringify({ patch }),
    } },
    { type: 'response_item', timestamp: '2026-08-14T10:00:02.000Z', payload: {
      type: 'function_call_output', call_id: 'call_p', output: 'applied',
    } },
  );
  const ev = scanChatText(text, 'codex').events.find((e) => e.kind === 'tool');
  assert.equal(ev.adds, 2);
  assert.equal(ev.dels, 1);
});

test('a notice needs both is_error and the denial phrase — a successful result with the same text is not a denial', () => {
  const denied = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_7', name: 'Bash', input: { command: 'git push' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:30.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_7', is_error: true, content: 'user denied' },
    ] } },
  );
  const deniedNotice = scanChatText(denied, 'claude').events.find((e) => e.kind === 'notice');
  assert.equal(deniedNotice.noticeKind, 'denied');

  const okWithSamePhrase = claudeLines(
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu_8', name: 'Bash', input: { command: 'grep user denied /var/log/auth.log' } },
    ] } },
    { type: 'user', timestamp: '2026-08-14T10:00:02.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_8', content: 'auth.log:42: user denied access for uid 501' },
    ] } },
  );
  const noNotice = scanChatText(okWithSamePhrase, 'claude').events.find((e) => e.kind === 'notice');
  assert.equal(noNotice, undefined, 'a successful result must not be read as a denial just because the phrase appears in its output');
});

test('the pending map is bounded: an old orphan is evicted once the cap is exceeded', () => {
  const scanner = createChatScanner('claude');
  // One tool_use per line, none ever paired with a tool_result — each stays
  // "pending" (orphaned) forever, the exact shape a killed/suspended pane
  // leaves behind. Feed comfortably more than the cap (32) so eviction must
  // have happened for the assertions below to hold.
  const toolUseLine = (id) => JSON.stringify({
    type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `cmd-${id}` } }] },
  });
  const toolResultLine = (id) => JSON.stringify({
    type: 'user', timestamp: '2026-08-14T10:00:02.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });

  for (let i = 0; i < 40; i += 1) scanner.push(toolUseLine(`tu_${i}`));

  // The oldest orphan (tu_0) must have been evicted — pending() no longer
  // reports it as the (only) survivor, and a tool_result arriving for it now
  // finds nothing to pair with and emits no event.
  const events = scanner.push(toolResultLine('tu_0'));
  assert.deepEqual(events, [], 'a result for a long-evicted call must pair with nothing');

  // A recent call (well within the cap of the most recent 32) must still be
  // tracked and pair normally — the cap must not have wiped everything.
  const recentEvents = scanner.push(toolResultLine('tu_39'));
  assert.equal(recentEvents.length, 1, 'a recent call must still pair correctly');
  assert.equal(recentEvents[0].id, 'tu_39');

  assert.notEqual(scanner.pending()?.target, 'cmd-tu_0', 'the oldest orphan must no longer be what pending() reports');
});

test('a blank Claude thinking block (content redacted into signature) still emits a presence-only thinking event', () => {
  const text = claudeLines(
    { type: 'user', timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'user', content: 'go' } },
    { type: 'assistant', timestamp: '2026-08-14T10:00:05.000Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'EqQBCgYIAxgCIAA...opaque...redacted' },
    ] } },
  );
  const think = scanChatText(text, 'claude').events.find((e) => e.kind === 'thinking');
  assert.ok(think, 'a blank thinking block must still produce an event, not be silently dropped');
  assert.ok(!('text' in think), 'blank thinking has no recoverable text, so the field must be absent, not an empty string');
  assert.equal(think.durationMs, 5000, 'a duration is still derivable even when the text is redacted');
});

// --- recap (Claude Code's end-of-turn "※ recap:" line) ---

test('a recap line becomes a recap event, split into summary and next step', () => {
  const line = JSON.stringify({
    type: 'system', subtype: 'away_summary', timestamp: '2026-08-20T10:00:00.000Z',
    content: "We're designing auth for the embed: a nonce exchanged for a cookie. Next: confirm the subdomain with security. (disable recaps in /config)",
  });
  const { events } = scanChatText(line, 'claude');
  assert.deepEqual(events.map((e) => e.kind), ['recap']);
  assert.equal(events[0].text, "We're designing auth for the embed: a nonce exchanged for a cookie.");
  assert.equal(events[0].next, 'confirm the subdomain with security.');
});

test('recapOf strips the /config chrome, which the chat view cannot act on', () => {
  const r = recapOf('Everything is fine. (disable recaps in /config)');
  assert.equal(r.text, 'Everything is fine.');
  assert.equal(r.next, null);
});

test('recapOf accepts "Next action:" as well as "Next:"', () => {
  assert.equal(recapOf('Did the research. Next action: plan phase 1.').next, 'plan phase 1.');
});

test('recapOf splits on the LAST marker, so "next:" inside the summary is prose', () => {
  const r = recapOf('We argued about what to do next: shipping. Next: ship it.');
  assert.equal(r.text, 'We argued about what to do next: shipping.');
  assert.equal(r.next, 'ship it.');
});

test('a recap with a marker but nothing after it keeps the whole body as summary', () => {
  const r = recapOf('Work is done. Next:');
  assert.equal(r.text, 'Work is done. Next:');
  assert.equal(r.next, null, 'an empty next would offer an empty prompt');
});

test('a blank or non-string recap yields no event', () => {
  assert.equal(recapOf('  (disable recaps in /config)'), null);
  assert.equal(recapOf(null), null);
  assert.equal(recapOf(undefined), null);
});

test('mightCarryChat lets an away_summary line through — it carries no role', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'away_summary', content: 'x. Next: y.' });
  assert.ok(!line.includes('"role":'), 'precondition: the role checks cannot see this line');
  assert.ok(mightCarryChat(line, 'claude'));
});

test('a recap line is inert for codex, which has no equivalent', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'away_summary', content: 'x. Next: y.' });
  assert.deepEqual(scanChatText(line, 'codex').events, []);
});
