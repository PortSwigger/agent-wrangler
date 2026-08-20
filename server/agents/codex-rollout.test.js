import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeCodex, listResumableCodex, activityInRangeCodex } from './codex-rollout.js';

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

test('activityInRangeCodex ignores non-message event kinds (token_count, task_started) and response_item lines', async () => {
  const { root, uuid } = fixtureTimestamped([
    { timestamp: '2026-07-01T09:00:00.000Z', type: 'session_meta', payload: {} },
    { timestamp: '2026-07-01T09:00:01.000Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-07-01T09:00:02.000Z', type: 'event_msg', payload: { type: 'token_count' } },
    { timestamp: '2026-07-01T09:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user' } },
  ]);
  const start = Date.parse('2026-07-01T00:00:00.000Z');
  const end = start + 86_400_000;
  const r = await activityInRangeCodex(uuid, start, end, root);
  assert.equal(r.messageCount, 0);
});

test('activityInRangeCodex returns null when no rollout exists for the id', async () => {
  const { root } = fixtureTimestamped([]);
  const r = await activityInRangeCodex('00000000-0000-0000-0000-000000000000', 0, 1, root);
  assert.equal(r, null);
});
