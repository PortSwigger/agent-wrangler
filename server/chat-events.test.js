import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanChatText, createChatScanner, mightCarryChat, recapOf, lineUuids, MAX_TOOL_TEXT } from './chat-events.js';

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

// --- slash-command plumbing is not conversation ---

const metaUser = (text) => JSON.stringify({
  type: 'user', timestamp: '2026-08-21T10:00:00.000Z', message: { role: 'user', content: text },
});

test('a slash-command invocation is not rendered as a user turn', () => {
  const line = metaUser('<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>sonnet</command-args>');
  assert.deepEqual(scanChatText(line, 'claude').events, []);
});

test('a slash command\'s own output is not rendered as a user turn', () => {
  const line = metaUser('<local-command-stdout>Set model to Sonnet 5</local-command-stdout>');
  assert.deepEqual(scanChatText(line, 'claude').events, []);
  const err = metaUser('<local-command-stderr>boom</local-command-stderr>');
  assert.deepEqual(scanChatText(err, 'claude').events, []);
});

// The guard must not swallow a real prompt that merely mentions a command.
test('a human prompt that talks about a slash command still renders', () => {
  const line = metaUser('Please run /model sonnet for me');
  assert.deepEqual(scanChatText(line, 'claude').events.map((e) => e.kind), ['user']);
});

test('a pasted image: the [Image: source: …] plumbing block is stripped, the [Image #1] marker stays, and a chip is emitted', () => {
  // Shape verified against a live transcript: prose carrying the marker, a real
  // base64 image block, then a trailing source block holding the absolute path.
  const { events } = scanChatText(claudeLines(
    {
      type: 'user',
      timestamp: '2026-08-25T10:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image #1]Describe the shape:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: '[Image: source: /Users/x/.agent-wrangler/memory/by-session/s1/pastes/paste-1-ab.png]' },
        ],
      },
    },
  ), 'claude');
  const user = events.find((e) => e.kind === 'user');
  // The absolute path is plumbing the reader cannot act on, and long enough to
  // bury the actual prompt.
  assert.equal(user.text, '[Image #1]Describe the shape:');
  // The marker survives because the prose can refer to it.
  assert.ok(user.text.includes('[Image #1]'));
  assert.deepEqual(user.images, [{ label: 'Image #1', name: 'paste-1-ab.png' }]);
});

test('a pasted image with no prose still emits the turn — gating on text alone would drop it', () => {
  const { events } = scanChatText(claudeLines(
    {
      type: 'user',
      timestamp: '2026-08-25T10:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: '[Image: source: /tmp/pastes/shot.png]' },
        ],
      },
    },
  ), 'claude');
  const user = events.find((e) => e.kind === 'user');
  assert.equal(user.text, '');
  assert.deepEqual(user.images, [{ label: 'Image #1', name: 'shot.png' }]);
});

test('several images are numbered in order, and one missing its source block still gets an unnamed chip', () => {
  const { events } = scanChatText(claudeLines(
    {
      type: 'user',
      timestamp: '2026-08-25T10:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B' } },
          { type: 'text', text: '[Image: source: /p/one.png]' },
        ],
      },
    },
  ), 'claude');
  const user = events.find((e) => e.kind === 'user');
  assert.equal(user.text, 'Compare these:');
  // Paired by order — the transcript offers no key linking an image block to its
  // source line, so the second is honestly unnamed rather than mislabelled.
  assert.deepEqual(user.images, [
    { label: 'Image #1', name: 'one.png' },
    { label: 'Image #2', name: '' },
  ]);
});

test('an ordinary user message carries no images key at all', () => {
  const { events } = scanChatText(claudeLines(
    { type: 'user', timestamp: '2026-08-25T10:00:00Z', message: { role: 'user', content: 'just words' } },
  ), 'claude');
  const user = events.find((e) => e.kind === 'user');
  assert.equal(user.text, 'just words');
  assert.equal('images' in user, false);
});

test('a user message keeps its line breaks verbatim (the composer sends multi-line prompts)', () => {
  const { events } = scanChatText(claudeLines(
    {
      type: 'user',
      timestamp: '2026-08-25T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: "I'm seeing this:\n\nERROR: NOT WORKING" }] },
    },
  ), 'claude');
  assert.equal(events.find((e) => e.kind === 'user').text, "I'm seeing this:\n\nERROR: NOT WORKING");
});

test('a chip label follows the marker in the prose, not a count from one (the TUI numbers per session)', () => {
  // Verified against a live session: the second image of a message was
  // [Image #10], so labelling its chip "Image #2" would contradict the text
  // sitting next to it and the pane.
  const { events } = scanChatText(claudeLines(
    {
      type: 'user',
      timestamp: '2026-08-25T10:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image #9] [Image #10]Name each colour.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B' } },
        ],
      },
    },
  ), 'claude');
  const user = events.find((e) => e.kind === 'user');
  assert.deepEqual(user.images.map((i) => i.label), ['Image #9', 'Image #10']);
});

// —— Branch pruning ————————————————————————————————————————————————————————————
// Fixtures carry real uuid/parentUuid links, unlike the ones above: a transcript
// is a tree, and the shapes below are the ones lifted off real files — a rewind
// (two prompt-bearing children of one node), a parallel tool fan-out (a second
// tool_use and the first call's result sharing a parent), and a compact boundary
// (a second root that continues rather than replaces).
const uu = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n, parent, o) => ({ uuid: uu(n), parentUuid: parent == null ? null : uu(parent), ...o });
const say = (n, parent, text, ts = '2026-08-27T09:00:00.000Z') =>
  at(n, parent, { type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const said = (n, parent, text, ts = '2026-08-27T09:00:01.000Z') =>
  at(n, parent, { type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] } });
const uses = (n, parent, id, ts = '2026-08-27T09:00:02.000Z') =>
  at(n, parent, { type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }] } });
const result = (n, parent, id, ts = '2026-08-27T09:00:03.000Z') =>
  at(n, parent, { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `out ${id}` }] } });

test('lineUuids: reads both ids off the raw line, and never confuses parentUuid or leafUuid for uuid', () => {
  const line = JSON.stringify({ parentUuid: uu(1), leafUuid: uu(9), type: 'user', uuid: uu(2) });
  assert.deepEqual(lineUuids(line), { uuid: uu(2), parent: uu(1) });
  // A root's parent is a real position in the tree, so it gets the ROOT sentinel
  // rather than null — roots compete with each other like any other siblings.
  const root = JSON.stringify({ parentUuid: null, type: 'user', uuid: uu(3) });
  assert.equal(lineUuids(root).uuid, uu(3));
  assert.notEqual(lineUuids(root).parent, null);
  assert.equal(lineUuids(JSON.stringify({ type: 'mode' })), null);
});

test('claude: a rewind drops the abandoned branch and keeps the one the pane is on', () => {
  // Two prompts hang off the same parent: the reader backtracked and asked again.
  const { events } = scanChatText(claudeLines(
    say(1, null, 'first prompt'),
    said(2, 1, 'first answer'),
    say(3, 2, 'abandoned prompt'),
    said(4, 3, 'abandoned answer'),
    say(5, 2, 'the prompt that stuck'),
    said(6, 5, 'the answer on screen'),
  ), 'claude');
  assert.deepEqual(events.map((e) => e.text), ['first prompt', 'first answer', 'the prompt that stuck', 'the answer on screen']);
});

test('claude: the LAST prompt-bearing branch wins, however many were abandoned', () => {
  const { events } = scanChatText(claudeLines(
    say(1, null, 'root'),
    say(2, 1, 'try one'),
    say(3, 1, 'try two'),
    say(4, 1, 'try three'),
  ), 'claude');
  assert.deepEqual(events.map((e) => e.text), ['root', 'try three']);
});

test('claude: a parallel tool fan-out is NOT a rewind — the newest line and its ancestors are too narrow', () => {
  // Both a second tool_use and the FIRST call's result are written as children of
  // the first tool_use. A spine walk from the newest line drops one of the two
  // results; only the prompt-bearing test keeps them, and 153 of 274 real
  // transcripts have live lines off that spine.
  const { events } = scanChatText(claudeLines(
    say(1, null, 'run both'),
    uses(2, 1, 'toolu_a'),
    uses(3, 2, 'toolu_b'),
    result(4, 2, 'toolu_a'),
    result(5, 3, 'toolu_b'),
    said(6, 5, 'both done'),
  ), 'claude');
  assert.deepEqual(events.map((e) => e.name ?? e.kind), ['user', 'Bash', 'Bash', 'assistant']);
  assert.deepEqual(events.filter((e) => e.kind === 'tool').map((e) => e.output), ['out toolu_a', 'out toolu_b']);
});

test('claude: a compact_boundary root continues the conversation instead of replacing it', () => {
  // /compact starts a second root, same as a rewind-to-the-very-start does. Letting
  // it compete hid 2104 pre-compact messages of a real session.
  const { events } = scanChatText(claudeLines(
    say(1, null, 'before the compact'),
    said(2, 1, 'answered before'),
    at(3, null, { type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-27T09:10:00.000Z' }),
    say(4, 3, 'after the compact'),
  ), 'claude');
  assert.deepEqual(events.map((e) => e.text), ['before the compact', 'answered before', 'after the compact']);
});

test('claude: a second root with its own prompt IS a rewind to before the first prompt', () => {
  const { events } = scanChatText(claudeLines(
    say(1, null, 'the run that was backed out'),
    said(2, 1, 'stale answer'),
    say(3, null, 'the run that stands'),
  ), 'claude');
  assert.deepEqual(events.map((e) => e.text), ['the run that stands']);
});

test('takeRewound: reports a rewind arriving on a follow-up push, and is read-and-clear', () => {
  const scanner = createChatScanner('claude');
  const push = (o) => scanner.pushTagged(JSON.stringify(o));
  push(say(1, null, 'first'));
  push(said(2, 1, 'answer'));
  push(say(3, 2, 'second'));
  push(said(4, 3, 'answered'));
  assert.equal(scanner.takeRewound(), false, 'a linear conversation is not a rewind');
  // The shape a real backtrack writes: the new prompt is a SIBLING of the one it
  // replaces, hanging off the line that preceded it.
  push(say(5, 2, 'asked again after backtracking'));
  assert.equal(scanner.takeRewound(), true);
  assert.equal(scanner.takeRewound(), false, 'read-and-clear, or every later poll rebuilds the stream');
});

test('takeRewound: a parallel tool fan-out and a compact boundary are not reported as rewinds', () => {
  const scanner = createChatScanner('claude');
  const push = (o) => scanner.pushTagged(JSON.stringify(o));
  push(say(1, null, 'run both'));
  push(uses(2, 1, 'toolu_a'));
  push(uses(3, 2, 'toolu_b'));
  push(result(4, 2, 'toolu_a'));
  push(result(5, 3, 'toolu_b'));
  assert.equal(scanner.takeRewound(), false);
  push(at(6, null, { type: 'system', subtype: 'compact_boundary', timestamp: '2026-08-27T09:10:00.000Z' }));
  push(say(7, 6, 'after the compact'));
  assert.equal(scanner.takeRewound(), false, 'a compact boundary is a wall, not a branch point');
});

test('claude: a line with no uuid at all is always kept — there is nothing to place it in the tree with', () => {
  const { events } = scanChatText(claudeLines(
    { type: 'user', timestamp: '2026-08-27T09:00:00.000Z', message: { role: 'user', content: 'no ids on this line' } },
    say(1, null, 'rooted'),
  ), 'claude');
  assert.deepEqual(events.map((e) => e.text), ['no ids on this line', 'rooted']);
});
