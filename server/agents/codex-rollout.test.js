import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeCodex, codexSubagentDetail, listResumableCodex, activityInRangeCodex, findRollout } from './codex-rollout.js';

function fixtureSessions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxr-'));
  const day = path.join(root, '2026', '06', '10');
  fs.mkdirSync(day, { recursive: true });
  const uuid = '11111111-2222-3333-4444-555555555555';
  const file = path.join(day, `rollout-2026-06-10T09-00-00-${uuid}.jsonl`);
  const usage = (i, c, o) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, total_tokens: i + o });
  const lines = [
    { type: 'session_meta', payload: { id: uuid, cwd: '/work/proj' } },
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Fix the parser bug' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1000, 0, 200), last_token_usage: usage(1000, 0, 200) } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(1500, 200, 300), last_token_usage: usage(500, 200, 100) } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { root, uuid };
}

test('analyzeCodex uses cumulative total_token_usage (last), nets out cache, estimates USD', async () => {
  const { root, uuid } = fixtureSessions();
  const r = await analyzeCodex(uuid, { sessionsDir: root });
  // last total_token_usage: input 1500 (incl 200 cached), output 300
  assert.equal(r.tokens.input, 1300);   // 1500 - 200 cached
  assert.equal(r.tokens.cacheRead, 200);
  assert.equal(r.tokens.output, 300);
  assert.ok(r.usd > 0);
  assert.equal(r.summary, 'Fix the parser bug');
  assert.deepEqual(r.subAgents, []);
});

test('analyzeCodex folds native sub-agent usage into its parent and exposes a completed row', async () => {
  const { root, uuid } = fixtureSessions();
  const child = '66666666-7777-8888-9999-aaaaaaaaaaaa';
  const file = path.join(root, '2026', '06', '10', `rollout-2026-06-10T09-05-00-${child}.jsonl`);
  fs.writeFileSync(file, [
    { timestamp: '2026-06-10T09:05:00.000Z', type: 'session_meta', payload: {
      id: child, parent_thread_id: uuid, thread_source: 'subagent', agent_path: '/root/investigate_parser', agent_role: 'worker',
    } },
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { timestamp: '2026-06-10T09:06:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 50 } } } },
    { timestamp: '2026-06-10T09:07:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');

  const parent = await analyzeCodex(uuid, { sessionsDir: root });
  const own = await analyzeCodex(child, { sessionsDir: root });

  assert.equal(parent.tokens.input, 1600);
  assert.equal(parent.tokens.cacheRead, 300);
  assert.equal(parent.tokens.output, 350);
  assert.equal(parent.subAgentUsd, own.usd);
  assert.ok(parent.usd > own.usd);
  assert.deepEqual(parent.subAgents, [{
    id: child,
    agentType: 'worker',
    label: 'investigate_parser',
    kind: 'background',
    status: 'completed',
    startedAt: Date.parse('2026-06-10T09:05:00.000Z'),
    endedAt: Date.parse('2026-06-10T09:07:00.000Z'),
    usd: own.usd,
  }]);
});

test('codexSubagentDetail reads prompt, tool calls, and result from a child rollout', async () => {
  const { root, uuid } = fixtureSessions();
  const child = '12121212-3434-5656-7878-909090909090';
  const file = path.join(root, '2026', '06', '10', `rollout-2026-06-10T09-05-00-${child}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: child, parent_thread_id: uuid, thread_source: 'subagent' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the parser' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command: 'npm test' }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The parser is sound.' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');

  assert.deepEqual(await codexSubagentDetail(uuid, child, { sessionsDir: root }), {
    prompt: 'Inspect the parser',
    toolCalls: [{ name: 'exec_command', target: 'npm test' }],
    result: 'The parser is sound.',
  });
});

test('codexSubagentDetail uses the native agent_message task path when its payload is encrypted', async () => {
  const { root, uuid } = fixtureSessions();
  const child = '21212121-3434-5656-7878-909090909090';
  const file = path.join(root, '2026', '06', '10', `rollout-2026-06-10T09-05-00-${child}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: child, parent_thread_id: uuid, thread_source: 'subagent' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are an agent in a team.' }] } },
    { type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/investigate_parser', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/investigate_parser\nSender: /root\nPayload:\n' }, { type: 'encrypted_content', text: '' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');

  assert.deepEqual(await codexSubagentDetail(uuid, child, { sessionsDir: root }), {
    prompt: 'investigate_parser', toolCalls: [], result: null,
  });
});

test('analyzeCodex keeps a multi-turn sub-agent running after a later task start', async () => {
  const { root, uuid } = fixtureSessions();
  const child = '31313131-3434-5656-7878-909090909090';
  const file = path.join(root, '2026', '06', '10', `rollout-2026-06-10T09-05-00-${child}.jsonl`);
  fs.writeFileSync(file, [
    { timestamp: '2026-06-10T09:05:00.000Z', type: 'session_meta', payload: { id: child, parent_thread_id: uuid, thread_source: 'subagent' } },
    { timestamp: '2026-06-10T09:06:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-06-10T09:07:00.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    { timestamp: '2026-06-10T09:08:00.000Z', type: 'event_msg', payload: { type: 'task_started' } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');

  const { subAgents } = await analyzeCodex(uuid, { sessionsDir: root });
  assert.equal(subAgents[0].status, 'running');
  assert.equal(subAgents[0].endedAt, null);
});

// The Codex CLI stopped writing EventMsg-shaped `user_message`/`agent_message`
// lines entirely around 2026-08-19 — every rollout since is `response_item`
// only. These fixtures pin the current shape so this file's own fixtures don't
// mask the regression the old event_msg-only ones did.
function fixtureResponseItemSessions() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxr-ri-'));
  const day = path.join(root, '2026', '09', '10');
  fs.mkdirSync(day, { recursive: true });
  const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = path.join(day, `rollout-2026-09-10T09-00-00-${uuid}.jsonl`);
  const lines = [
    { type: 'session_meta', payload: { id: uuid, cwd: '/work/proj' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are an agent...' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n\nDo not add comments.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the parser bug' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { root, uuid };
}

test('analyzeCodex reads the summary from a response_item message (current rollout shape)', async () => {
  const { root, uuid } = fixtureResponseItemSessions();
  const r = await analyzeCodex(uuid, { sessionsDir: root });
  assert.equal(r.summary, 'Fix the parser bug');
  assert.equal(r.currentModel, 'gpt-5.6-terra');
});

test('analyzeCodex skips a synthetic response_item user message (AGENTS.md, developer role) when picking the summary', async () => {
  const { root, uuid } = fixtureResponseItemSessions();
  const r = await analyzeCodex(uuid, { sessionsDir: root });
  assert.notEqual(r.summary, '# AGENTS.md instructions\n\nDo not add comments.');
});

// Caught in review: isSyntheticCodexMessage originally short-circuited on a
// blanket `text.startsWith('<')`, which is stricter than chat-events.js's own
// isSyntheticCodex (prefix-list only). A real human message that happens to
// start with '<' (pasted XML/HTML/markdown) must still be picked up.
test('analyzeCodex uses a real user message that starts with "<" as the summary, rather than treating it as synthetic', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxr-angle-'));
  const day = path.join(root, '2026', '09', '10');
  fs.mkdirSync(day, { recursive: true });
  const uuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const file = path.join(day, `rollout-2026-09-10T09-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<config><value>hello</value></config>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'got it' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = await analyzeCodex(uuid, { sessionsDir: root });
  assert.equal(r.summary, '<config><value>hello</value></config>');
});

test('listResumableCodex reads the summary from a response_item message', async () => {
  const { root, uuid } = fixtureResponseItemSessions();
  const { candidates } = await listResumableCodex(new Set(), { sessionsDir: root, now: Date.parse('2026-09-10T10:00:00Z') });
  assert.equal(candidates[0].summary, 'Fix the parser bug');
});

test('analyzeCodex returns nulls for an unknown id', async () => {
  const { root } = fixtureSessions();
  const r = await analyzeCodex('00000000-0000-0000-0000-000000000000', { sessionsDir: root });
  assert.equal(r.usd, null);
  assert.equal(r.tokens, null);
});

test('analyzeCodex keeps the latest completed turn model when a new turn is pending', async () => {
  const { root, uuid } = fixtureTimestamped([
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
  ]);
  const r = await analyzeCodex(uuid, { sessionsDir: root });
  assert.equal(r.currentModel, 'gpt-5.5');
});

// A models_cache.json fixture, in the same shape Codex's own CLI writes under
// ~/.codex/models_cache.json — analyzeCodex must never hand-copy these numbers.
function fixtureModelsCache(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxmc-'));
  const file = path.join(dir, 'models_cache.json');
  fs.writeFileSync(file, JSON.stringify({ models: models.map((m) => ({ slug: m.slug, context_window: m.contextWindow })) }));
  return file;
}

test('analyzeCodex computes contextPercent from the latest per-call usage, not the cumulative total', async () => {
  const { root, uuid } = fixtureTimestamped([
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
    // Cumulative usage (token_count) is huge, so contextPercent would read as
    // ~100% almost immediately if it were derived from this instead.
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20_000_000, output_tokens: 50_000 } } } },
    { type: 'token_usage_record', payload: { usage: { input_tokens: 54_400, cached_input_tokens: 50_000, output_tokens: 200, total_tokens: 54_600 } } },
  ]);
  const modelsCachePath = fixtureModelsCache([{ slug: 'gpt-5.6-terra', contextWindow: 272_000 }]);
  const r = await analyzeCodex(uuid, { sessionsDir: root, modelsCachePath });
  assert.equal(r.contextPercent, 20); // 54400 / 272000 = 20%
});

test('analyzeCodex clamps contextPercent at 100 rather than reporting over', async () => {
  const { root, uuid } = fixtureTimestamped([
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    { type: 'token_usage_record', payload: { usage: { input_tokens: 500_000 } } },
  ]);
  const modelsCachePath = fixtureModelsCache([{ slug: 'gpt-5.6-sol', contextWindow: 272_000 }]);
  const r = await analyzeCodex(uuid, { sessionsDir: root, modelsCachePath });
  assert.equal(r.contextPercent, 100);
});

test('analyzeCodex reports contextPercent as null for a model absent from the cache, rather than guessing', async () => {
  const { root, uuid } = fixtureTimestamped([
    { type: 'turn_context', payload: { model: 'gpt-5.4-mini' } },
    { type: 'token_usage_record', payload: { usage: { input_tokens: 10_000 } } },
  ]);
  const modelsCachePath = fixtureModelsCache([{ slug: 'gpt-5.6-sol', contextWindow: 272_000 }]);
  const r = await analyzeCodex(uuid, { sessionsDir: root, modelsCachePath });
  assert.equal(r.contextPercent, null);
});

test('analyzeCodex reports contextPercent as null when the models cache file does not exist', async () => {
  const { root, uuid } = fixtureTimestamped([
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
    { type: 'token_usage_record', payload: { usage: { input_tokens: 10_000 } } },
  ]);
  const r = await analyzeCodex(uuid, { sessionsDir: root, modelsCachePath: path.join(os.tmpdir(), 'does-not-exist-models-cache.json') });
  assert.equal(r.contextPercent, null);
});

test('analyzeCodex reports contextPercent as null before any per-call usage record has been seen', async () => {
  const { root, uuid } = fixtureTimestamped([
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
  ]);
  const modelsCachePath = fixtureModelsCache([{ slug: 'gpt-5.6-terra', contextWindow: 272_000 }]);
  const r = await analyzeCodex(uuid, { sessionsDir: root, modelsCachePath });
  assert.equal(r.contextPercent, null);
});

test('analyzeCodex returns contextPercent: null for an unknown id', async () => {
  const { root } = fixtureSessions();
  const r = await analyzeCodex('00000000-0000-0000-0000-000000000000', { sessionsDir: root });
  assert.equal(r.contextPercent, null);
});

// Adversarial review (PR #148): analyzeCodex's own result cache is keyed on the
// rollout FAMILY's signature (file sizes/mtimes), which does not change when
// Codex CLI refreshes models_cache.json in place — so the fix that folds the
// cache file's own mtime into that signature is load-bearing. Prove it here
// rather than only asserting it by inspection: same session, same rollout
// (nothing about it changes between the two calls), only the models cache
// mutates — a stale cache would keep serving the FIRST contextPercent forever.
test('analyzeCodex invalidates its own result cache when models_cache.json changes, even though no rollout file did', async () => {
  const { root, uuid } = fixtureTimestamped([
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
    { type: 'token_usage_record', payload: { usage: { input_tokens: 54_400 } } },
  ]);
  const modelsCachePath = fixtureModelsCache([{ slug: 'gpt-5.6-terra', contextWindow: 272_000 }]);
  const first = await analyzeCodex(uuid, { sessionsDir: root, modelsCachePath });
  assert.equal(first.contextPercent, 20); // 54400 / 272000

  // Codex CLI refreshes its cache in place with a smaller window for the same
  // model — nudge the mtime forward explicitly so this doesn't depend on the
  // filesystem's clock resolution happening to tick between the two writes.
  const bumpedMtime = (fs.statSync(modelsCachePath).mtimeMs + 60_000) / 1000;
  fs.writeFileSync(modelsCachePath, JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', context_window: 100_000 }] }));
  fs.utimesSync(modelsCachePath, bumpedMtime, bumpedMtime);

  const second = await analyzeCodex(uuid, { sessionsDir: root, modelsCachePath });
  assert.equal(second.contextPercent, 54); // 54400 / 100000, rounded — NOT the stale 20
});

test('listResumableCodex surfaces sessions with cwd + summary, tagged codex', async () => {
  const { root, uuid } = fixtureSessions();
  const { candidates, total } = await listResumableCodex(new Set(), { sessionsDir: root, now: Date.parse('2026-06-10T10:00:00Z') });
  assert.equal(total, 1);
  assert.equal(candidates[0].sessionId, uuid);
  assert.equal(candidates[0].cwd, '/work/proj');
  assert.equal(candidates[0].summary, 'Fix the parser bug');
  assert.equal(candidates[0].agent, 'codex');
});

test('listResumableCodex excludes ids already shown', async () => {
  const { root, uuid } = fixtureSessions();
  const { total } = await listResumableCodex(new Set([uuid]), { sessionsDir: root, now: Date.parse('2026-06-10T10:00:00Z') });
  assert.equal(total, 0);
});

test('listResumableCodex excludes native sub-agent rollouts', async () => {
  const { root, uuid } = fixtureSessions();
  const child = '41414141-3434-5656-7878-909090909090';
  fs.writeFileSync(path.join(root, '2026', '06', '10', 'rollout-2026-06-10T09-05-00-' + child + '.jsonl'), [
    { type: 'session_meta', payload: { id: child, parent_thread_id: uuid, thread_source: 'subagent' } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');

  const { candidates } = await listResumableCodex(new Set(), { sessionsDir: root, now: Date.parse('2026-06-10T10:00:00Z') });
  assert.deepEqual(candidates.map((candidate) => candidate.sessionId), [uuid]);
});

function fixtureTimestamped(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxr-ts-'));
  const uuid = '99999999-8888-7777-6666-555555555555';
  const file = path.join(root, `rollout-2026-07-01T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { root, uuid };
}

test('activityInRangeCodex counts user_message/agent_message turns with a timestamp in range', async () => {
  const { root, uuid } = fixtureTimestamped([
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
    { timestamp: '2026-07-01T09:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } },
    { timestamp: '2026-07-02T09:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'next day' } },
  ]);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const end = start + 86_400_000;
  const r = await activityInRangeCodex(uuid, start, end, root);
  assert.equal(r.messageCount, 2);
  assert.equal(r.firstActivity, start + 9 * 3_600_000);
  assert.equal(r.lastActivity, start + 9 * 3_600_000 + 5000);
});

test('activityInRangeCodex ignores non-message event kinds (token_count, task_started)', async () => {
  const { root, uuid } = fixtureTimestamped([
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'session_meta', payload: {} },
    { timestamp: '2026-07-01T09:00:01.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-01T09:00:02.000Z', type: 'event_msg', payload: { type: 'token_count' } },
  ]);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const end = start + 86_400_000;
  const r = await activityInRangeCodex(uuid, start, end, root);
  assert.equal(r.messageCount, 0);
});

// Current rollouts (post ~2026-08-19) carry no event_msg user_message/agent_message
// lines at all — only response_item. This is the shape that matters going forward.
test('activityInRangeCodex counts response_item user/assistant messages (current rollout shape)', async () => {
  const { root, uuid } = fixtureTimestamped([
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    { timestamp: '2026-07-01T09:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } },
    { timestamp: '2026-07-02T09:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next day' }] } },
  ]);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const end = start + 86_400_000;
  const r = await activityInRangeCodex(uuid, start, end, root);
  assert.equal(r.messageCount, 2);
  assert.equal(r.firstActivity, start + 9 * 3_600_000);
  assert.equal(r.lastActivity, start + 9 * 3_600_000 + 5000);
});

test('activityInRangeCodex excludes a developer-role response_item and a synthetic user-role one (AGENTS.md, environment_context)', async () => {
  const { root, uuid } = fixtureTimestamped([
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } },
    { timestamp: '2026-07-01T09:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }] } },
    { timestamp: '2026-07-01T09:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } },
    { timestamp: '2026-07-01T09:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a real prompt' }] } },
  ]);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const end = start + 86_400_000;
  const r = await activityInRangeCodex(uuid, start, end, root);
  assert.equal(r.messageCount, 1);
});

// Pre-8/19 rollouts carry BOTH shapes for the same turn (event_msg mirrors
// response_item verbatim — see chat-events.js's own comment on this). ORing
// the two shapes together would double the true turn count on every legacy
// rollout; response_item must win outright when it has anything at all.
test('activityInRangeCodex does not double-count a legacy rollout that carries both event_msg and response_item for the same turn', async () => {
  const { root, uuid } = fixtureTimestamped([
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    { timestamp: '2026-07-01T09:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } },
    { timestamp: '2026-07-01T09:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } },
  ]);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const end = start + 86_400_000;
  const r = await activityInRangeCodex(uuid, start, end, root);
  assert.equal(r.messageCount, 2);
});

// Caught in review: on a legacy rollout with a real '<'-leading user message,
// the (previously overbroad) synthetic filter dropped the user turn from the
// "current" tally while the assistant turn still made it non-zero — so the
// per-file preference picked the undercounted "current" tally over the
// correct "legacy" one. Confirms the fix, not just the filter unit-level.
test('activityInRangeCodex counts a "<"-leading real message on a mixed legacy/current rollout without losing it to the tally preference', async () => {
  const { root, uuid } = fixtureTimestamped([
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: '<config>hello</config>' } },
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<config>hello</config>' }] } },
    { timestamp: '2026-07-01T09:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'got it' } },
    { timestamp: '2026-07-01T09:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'got it' }] } },
  ]);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const end = start + 86_400_000;
  const r = await activityInRangeCodex(uuid, start, end, root);
  assert.equal(r.messageCount, 2);
});

test('activityInRangeCodex returns null when no rollout exists for the id', async () => {
  const { root } = fixtureTimestamped([]);
  const r = await activityInRangeCodex('00000000-0000-0000-0000-000000000000', 0, 1, root);
  assert.equal(r, null);
});


// --- findRollout ---------------------------------------------------------
// Deliberately parallel to transcript-reader.test.js's findTranscript tests,
// including the #96 stale-path case: the two resolvers are the Claude and Codex
// halves of one job (conversation-file.js), and they have to behave alike.

function rolloutTree(uuids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxr-find-'));
  const day = path.join(root, '2026', '09', '06');
  fs.mkdirSync(day, { recursive: true });
  const files = {};
  for (const uuid of uuids) {
    const file = path.join(day, `rollout-2026-09-06T09-00-00-${uuid}.jsonl`);
    fs.writeFileSync(file, '');
    files[uuid] = file;
  }
  return { root, files };
}

test('findRollout: resolves a session id to its rollout, deep in the date tree', async () => {
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  const { root, files } = rolloutTree([a, b]);
  assert.equal(await findRollout(a, root), files[a]);
  assert.equal(await findRollout(b, root), files[b]);
});

test('findRollout: an unknown id is null, and the miss is NOT cached', async () => {
  const uuid = '33333333-3333-3333-3333-333333333333';
  const { root } = rolloutTree([]);
  assert.equal(await findRollout(uuid, root), null);
  // Codex discovers a session's live id post-launch, so a rollout can appear
  // moments after the first lookup. Caching the miss would leave that session's
  // chat view permanently empty with nothing to invalidate it.
  const day = path.join(root, '2026', '09', '06');
  const late = path.join(day, `rollout-2026-09-06T09-30-00-${uuid}.jsonl`);
  fs.writeFileSync(late, '');
  assert.equal(await findRollout(uuid, root), late);
});

test('findRollout: a repeat lookup is served from cache without re-walking the tree', async () => {
  // The performance claim the chat view rests on, asserted rather than assumed:
  // the view polls every 2s, and a walk of ~/.codex/sessions per poll is the
  // cost this cache exists to remove. Counting readdir calls is the only way to
  // see the difference — the return value is identical either way.
  const uuid = '44444444-4444-4444-4444-444444444444';
  const { root, files } = rolloutTree([uuid]);
  const realReaddir = fsp.readdir;
  let reads = 0;
  fsp.readdir = (...args) => { reads += 1; return realReaddir(...args); };
  try {
    assert.equal(await findRollout(uuid, root), files[uuid]);
    assert.ok(reads > 0, 'the first lookup walks the tree');
    const afterFirst = reads;
    for (let i = 0; i < 5; i += 1) assert.equal(await findRollout(uuid, root), files[uuid]);
    assert.equal(reads, afterFirst, 'five more polls must not walk the tree again');
  } finally {
    fsp.readdir = realReaddir;
  }
});

test('findRollout: a cached path that stops existing is evicted, not returned forever', async () => {
  // The Codex half of PR #96. A rollout pruned or moved under a cached path used
  // to freeze that session; the hit is re-checked with existsSync instead.
  const uuid = '55555555-5555-5555-5555-555555555555';
  const { root, files } = rolloutTree([uuid]);
  assert.equal(await findRollout(uuid, root), files[uuid]);
  fs.rmSync(files[uuid]);
  assert.equal(await findRollout(uuid, root), null, 'the dead cached path must not be handed back');

  const day = path.join(root, '2026', '09', '07');
  fs.mkdirSync(day, { recursive: true });
  const moved = path.join(day, `rollout-2026-09-07T09-00-00-${uuid}.jsonl`);
  fs.writeFileSync(moved, '');
  assert.equal(await findRollout(uuid, root), moved, 'and the re-walk finds it in its new home');
});

test('findRollout: ignores files that are not named like a rollout', async () => {
  const uuid = '66666666-6666-6666-6666-666666666666';
  const { root } = rolloutTree([]);
  const day = path.join(root, '2026', '09', '06');
  fs.writeFileSync(path.join(day, `${uuid}.jsonl`), '');
  fs.writeFileSync(path.join(day, `rollout-2026-09-06T09-00-00-${uuid}.txt`), '');
  assert.equal(await findRollout(uuid, root), null);
});

test('findRollout: a missing sessions dir is null, never a throw', async () => {
  const root = path.join(os.tmpdir(), 'cxr-does-not-exist-', String(Date.now()));
  assert.equal(await findRollout('77777777-7777-7777-7777-777777777777', root), null);
});
