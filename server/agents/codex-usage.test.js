import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRolloutUsage, reconcileRollout, sumDeltas } from './codex-usage.js';

const u = (input, cached, output, reasoning = 0) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
  output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const tc = (ts, total, last, extra = {}) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last }, ...extra } });
const ctx = (ts, model, effort, turn = 't1') => ({ timestamp: ts, type: 'turn_context', payload: { model, effort, turn_id: turn, root_turn_id: turn } });
const meta = (ts, extra = {}) => ({ timestamp: ts, ordinal: 0, type: 'session_meta', payload: { id: 'thread-1', thread_source: 'user', ...extra } });
const text = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

test('each cumulative checkpoint becomes one delta at its own time, model and effort', () => {
  const { state, entries } = parseRolloutUsage(text([
    meta('2026-09-01T23:59:00.000Z'),
    ctx('2026-09-01T23:59:01.000Z', 'gpt-6-sol', 'high', 'turn-a'),
    tc('2026-09-01T23:59:30.000Z', u(1000, 0, 100, 40), u(1000, 0, 100, 40)),
    tc('2026-09-02T00:00:30.000Z', u(2500, 800, 300, 90), u(1500, 800, 200, 50)),
  ]));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => new Date(e.ts).toISOString().slice(0, 10)), ['2026-09-01', '2026-09-02']);
  assert.deepEqual(entries[1].d, { input: 1500, cached: 800, output: 200, reasoning: 50, total: 1700, cacheWrite: 0 });
  assert.equal(entries[1].model, 'gpt-6-sol');
  assert.equal(entries[1].effort, 'high');
  assert.equal(entries[1].turn, 'turn-a');
  assert.equal(entries[1].reqIn, 1500);
  assert.equal(state.baselineKind, 'zero');
  assert.equal(reconcileRollout(state, entries).status, 'ok');
});

test('a re-emitted checkpoint with an unchanged total charges nothing', () => {
  const { entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    ctx('2026-09-01T10:00:01.000Z', 'gpt-5.5', 'medium'),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100)),
    tc('2026-09-01T10:00:06.000Z', u(1000, 0, 100), u(1000, 0, 100)),
  ]));
  assert.equal(entries.length, 1);
});

test('a model or effort switch attributes later deltas to the new context only', () => {
  const { entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    ctx('2026-09-01T10:00:01.000Z', 'gpt-6-sol', 'low'),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100)),
    ctx('2026-09-01T10:01:00.000Z', 'gpt-6-sol', 'xhigh', 't2'),
    tc('2026-09-01T10:01:05.000Z', u(2000, 0, 300), u(1000, 0, 200)),
    ctx('2026-09-01T10:02:00.000Z', 'gpt-6-luna', 'xhigh', 't3'),
    tc('2026-09-01T10:02:05.000Z', u(2600, 0, 350), u(600, 0, 50)),
  ]));
  assert.deepEqual(entries.map((e) => `${e.model}/${e.effort}/${e.d.input}`), [
    'gpt-6-sol/low/1000', 'gpt-6-sol/xhigh/1000', 'gpt-6-luna/xhigh/600',
  ]);
});

test('a checkpoint before any model context stays unknown rather than borrowing a later model', () => {
  const { entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100)),
    ctx('2026-09-01T10:01:00.000Z', 'gpt-6-sol', 'high'),
    tc('2026-09-01T10:01:05.000Z', u(2000, 0, 200), u(1000, 0, 100)),
  ]));
  assert.equal(entries[0].model, null);
  assert.equal(entries[1].model, 'gpt-6-sol');
});

test('thread_settings_applied is model evidence until a turn_context arrives', () => {
  const { entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    { timestamp: '2026-09-01T10:00:00.100Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', reasoning_effort: 'low', service_tier: 'default' } } },
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100)),
  ]));
  assert.equal(entries[0].model, 'gpt-6-luna');
  assert.equal(entries[0].effort, 'low');
  assert.equal(entries[0].tier, 'default');
});

test('an unexplained starting value becomes one explicit unknown-time, unknown-model entry', () => {
  const { state, entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    ctx('2026-09-01T10:00:01.000Z', 'gpt-6-sol', 'high'),
    tc('2026-09-01T10:00:05.000Z', u(5000, 1000, 500), u(1000, 0, 100)),
  ]));
  assert.equal(state.baselineKind, 'unexplained');
  const [base, first] = entries;
  assert.equal(base.kind, 'baseline');
  assert.equal(base.ts, null);
  assert.equal(base.model, null);
  assert.equal(base.d.input, 4000);
  assert.equal(first.d.input, 1000);
  assert.equal(reconcileRollout(state, entries).status, 'ok');
  assert.equal(sumDeltas(entries).total, 5500);
});

test('a resumed file (history_base) charges only usage after the resume', () => {
  const { state, entries } = parseRolloutUsage(text([
    { ...meta('2026-09-02T09:00:00.000Z', { history_base: { thread_id: 'thread-1', end_ordinal_exclusive: 40 } }), ordinal: 40 },
    { timestamp: '2026-09-02T09:00:10.000Z', ordinal: 41, ...ctx('2026-09-02T09:00:10.000Z', 'gpt-6-sol', 'high') },
    { ...tc('2026-09-02T09:00:20.000Z', u(9000, 0, 900), u(1000, 0, 100)), ordinal: 42 },
  ]));
  assert.equal(state.baselineKind, 'history_base');
  assert.equal(state.meta.startOrd, 40);
  assert.equal(state.inherited.input, 8000);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].d.input, 1000);
  assert.equal(entries[0].ord, 42);
  assert.equal(reconcileRollout(state, entries).status, 'ok');
});

test('a fork never charges the history it replays from its source', () => {
  const at = '2026-08-05T11:43:17.290Z';
  const { state, entries } = parseRolloutUsage(text([
    meta(at, { forked_from_id: 'source-thread' }),
    { ...ctx(at, 'gpt-5.5', 'low', 'parent-turn') },
    tc(at, u(17000, 0, 800), u(17000, 0, 800)),
    tc('2026-08-05T11:43:17.291Z', u(37000, 10000, 1400), u(20000, 10000, 600)),
    ctx('2026-08-05T11:43:26.357Z', 'gpt-5.5', 'low', 'fork-turn'),
    tc('2026-08-05T11:43:40.000Z', u(60000, 30000, 2000), u(23000, 20000, 600)),
  ]));
  assert.equal(state.baselineKind, 'fork');
  assert.equal(state.inherited.input, 37000);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].d.input, 23000);
  assert.equal(entries[0].turn, 'fork-turn');
  assert.equal(reconcileRollout(state, entries).status, 'ok');
});

test('a counter that dips and never recovers reports a mismatch instead of hiding it', () => {
  const { state, entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    ctx('2026-09-01T10:00:01.000Z', 'gpt-5.5', 'medium'),
    tc('2026-09-01T10:00:05.000Z', u(2000, 0, 200), u(2000, 0, 200)),
    tc('2026-09-01T10:00:06.000Z', u(1500, 0, 200), u(500, 0, 0)),
  ]));
  assert.equal(entries.length, 1);
  assert.equal(reconcileRollout(state, entries).status, 'mismatch');
});

test('per-response token_usage_record rows are diagnostics, never added to the charge', () => {
  const rec = (ts, usage) => ({ timestamp: ts, type: 'token_usage_record', payload: { response_id: 'r', usage } });
  const { state, entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    ctx('2026-09-01T10:00:01.000Z', 'gpt-5.5', 'medium'),
    rec('2026-09-01T10:00:04.000Z', u(1000, 0, 100)),
    rec('2026-09-01T10:00:04.500Z', u(1000, 0, 100)),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100)),
  ]));
  assert.equal(sumDeltas(entries).input, 1000);
  assert.equal(state.recordCount, 2);
  assert.equal(state.recordSum.input, 2000);
});

test('a legacy rollout with no last_token_usage or ordinals still charges from zero', () => {
  const { state, entries } = parseRolloutUsage(text([
    { type: 'session_meta', payload: { id: 'legacy' } },
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(1000, 0, 100) } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(1600, 0, 200) } } },
  ]));
  assert.equal(state.baselineKind, 'zero');
  assert.deepEqual(entries.map((e) => [e.ts, e.d.input]), [[null, 1000], [null, 600]]);
});

test('ChatGPT plan type on a checkpoint is carried on its entry', () => {
  const { entries } = parseRolloutUsage(text([
    meta('2026-09-01T10:00:00.000Z'),
    ctx('2026-09-01T10:00:01.000Z', 'gpt-5.5', 'medium'),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100), { rate_limits: { plan_type: 'business' } }),
  ]));
  assert.equal(entries[0].plan, 'business');
});
