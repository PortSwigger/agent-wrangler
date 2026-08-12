import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAllDaily, rollup, buildUsage, _resetUsageFileCache, _usageFileCacheStats } from './usage-report.js';
import { costUsd, costUsdByType } from './pricing.js';
import { analyze } from './transcript-reader.js';

const NOW = Date.parse('2026-07-16T00:00:00.000Z');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// A fresh { dataDir, projectsDir, codexSessionsDir } trio and helpers to populate it
// the way the real trees look on disk.
function makeDirs() {
  return { dataDir: tmp('aw-data-'), projectsDir: tmp('aw-proj-'), codexSessionsDir: tmp('aw-codex-') };
}
function writeStores(dataDir, { entries = {}, tasks = [], assignments = {} }) {
  fs.writeFileSync(path.join(dataDir, 'mappings.json'), JSON.stringify({ sessions: entries }));
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ tasks, assignments }));
}
function claudeTranscript(projectsDir, { sessionId, cwd = '/work/proj', lines }) {
  const bucket = path.join(projectsDir, cwd.replace(/[/.]/g, '-'));
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path.join(bucket, `${sessionId}.jsonl`);
}
const turn = (id, model, usage, ts, block = 'text') =>
  ({ type: 'assistant', timestamp: ts, message: { id, model, role: 'assistant', content: [{ type: block }], usage } });

const activeBuckets = (r) => r.buckets.filter((b) => b.total.usd > 0 || b.total.tokens.input > 0);

test('buckets each transcript line into its own UTC calendar day', async () => {
  const d = makeDirs();
  const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 1000, output_tokens: 2000 }, '2026-07-10T12:00:00.000Z'),
    turn('m2', 'claude-opus', { input_tokens: 500, output_tokens: 100 }, '2026-07-15T09:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { card1: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } }, tasks: [{ id: 't1', name: 'Alpha' }], assignments: { card1: 't1' } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  const active = activeBuckets(r);
  assert.deepEqual(active.map((b) => b.key), ['2026-07-10', '2026-07-15']);
  assert.equal(active[0].total.tokens.output, 2000);
  assert.equal(active[1].total.tokens.input, 500);
});

test('dedups multi-block turns by message.id (one API call billed once)', async () => {
  const d = makeDirs();
  const sid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 400 };
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', usage, '2026-07-12T12:00:00.000Z', 'thinking'),
    turn('m1', 'claude-opus', usage, '2026-07-12T12:00:00.000Z', 'text'),
    turn('m1', 'claude-opus', usage, '2026-07-12T12:00:00.000Z', 'tool_use'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 1000, 'three blocks of one message counted once');
  assert.equal(r.totals.tokens.output, 2000);
  assert.equal(r.totals.tokens.cacheRead, 400);
});

test('splits cache-write tokens by TTL and matches pricing.costUsd', async () => {
  const d = makeDirs();
  const sid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-sonnet', { input_tokens: 100, output_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      cache_read_input_tokens: 5000 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.cacheWrite, 3000);
  assert.equal(r.totals.tokens.cacheRead, 5000);
  const expected = costUsd({ 'claude-sonnet': { input: 100, output: 200, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 5000 } });
  assert.ok(Math.abs(r.totals.usd - expected) < 1e-9);
});

test('rolls days up to week and month buckets', async () => {
  const d = makeDirs();
  const sid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-06T12:00:00.000Z'), // Mon, week of Jul 6
    turn('m2', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-08T12:00:00.000Z'), // Wed, same week
    turn('m3', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-15T12:00:00.000Z'), // next week
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const scan = await scanAllDaily(d);
  const wk = activeBuckets(rollup(scan, { granularity: 'week', now: NOW }));
  assert.deepEqual(wk.map((b) => b.key), ['2026-07-06', '2026-07-13']);
  assert.equal(wk[0].total.tokens.input, 200, 'two days in the first week are summed');
  assert.equal(wk[1].total.tokens.input, 100);

  const mo = activeBuckets(rollup(scan, { granularity: 'month', now: NOW }));
  assert.deepEqual(mo.map((b) => b.key), ['2026-07']);
  assert.equal(mo[0].total.tokens.input, 300);
});

test('attributes spend per task and orders tasks by spend', async () => {
  const d = makeDirs();
  const big = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const small = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  claudeTranscript(d.projectsDir, { sessionId: big, cwd: '/work/big', lines: [
    turn('m1', 'claude-opus', { input_tokens: 100000, output_tokens: 100000 }, '2026-07-14T12:00:00.000Z'),
  ] });
  claudeTranscript(d.projectsDir, { sessionId: small, cwd: '/work/small', lines: [
    turn('m2', 'claude-opus', { input_tokens: 10, output_tokens: 10 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, {
    entries: {
      cb: { agent: 'claude', liveSessionId: big, cwd: '/work/big' },
      cs: { agent: 'claude', liveSessionId: small, cwd: '/work/small' },
    },
    tasks: [{ id: 't1', name: 'Big' }, { id: 't2', name: 'Small' }],
    assignments: { cb: 't1', cs: 't2' },
  });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.deepEqual(r.tasks.map((t) => t.name), ['Big', 'Small']);
  const day = r.buckets.find((b) => b.key === '2026-07-14');
  assert.ok(day.byTask.t1.usd > day.byTask.t2.usd);
});

test('falls back to the archived task snapshot when the assignment is gone', async () => {
  const d = makeDirs();
  const sid = '11111111-1111-1111-1111-111111111111';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  // No assignments entry (task was deleted); the archived entry keeps the snapshot.
  writeStores(d.dataDir, { entries: {
    card: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj', archivedAt: 1, task: { id: 't9', name: 'Gone Task' } },
  } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.deepEqual(r.tasks.map((t) => t.name), ['Gone Task']);
});

test('counts sub-agent spend from background transcripts, not the inline lower bound', async () => {
  const d = makeDirs();
  const sid = '22222222-2222-2222-2222-222222222222';
  const file = claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  const subDir = path.join(path.dirname(file), sid, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'), [
    turn('s1', 'claude-opus', { input_tokens: 5000, output_tokens: 5000 }, '2026-07-14T12:30:00.000Z'),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 5100, 'parent + sub-agent input tokens combined');
  assert.ok(r.totals.subAgentUsd > 0);
});

// --- advisor consultations: usage.iterations[] classification -----------------
// Mirrors transcript-reader.test.js's coverage at this scanner's level (CLAUDE.md:
// "Three scanners must agree"). The native advisor tool nests an extra
// "advisor_message" iteration inside usage.iterations[], its own `model`, never
// cached — top-level usage fields only sum the "message" iterations.
test('advisor consultations are folded into usd and broken out as advisorUsd, priced at their own model', async () => {
  const d = makeDirs();
  const sid = '44444444-4444-4444-4444-444444444444';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-sonnet', {
      iterations: [
        { type: 'message', input_tokens: 1000, output_tokens: 200 },
        { type: 'advisor_message', model: 'claude-opus', input_tokens: 3000, output_tokens: 100 },
      ],
    }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  const expectedParent = costUsd({ 'claude-sonnet': { input: 1000, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  const expectedAdvisor = costUsd({ 'claude-opus': { input: 3000, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  assert.ok(Math.abs(r.totals.usd - (expectedParent + expectedAdvisor)) < 1e-9);
  assert.ok(Math.abs(r.totals.advisorUsd - expectedAdvisor) < 1e-9);
  const advisorModel = r.dimensions.model.find((m) => m.key === 'claude-opus (advisor)');
  assert.ok(advisorModel, "the advisor iteration shows up under its OWN model, not the parent turn's");
  assert.ok(Math.abs(advisorModel.usd - expectedAdvisor) < 1e-9);
});

// The Model slice must never fold a consult into ordinary usage just because the
// advisor happened to be the same model as the parent turn — that would make the
// Model view understate the advisor's real cost and overstate normal usage of it.
test('an advisor consult on the SAME model the parent turn used is a separate row in the Model slice', async () => {
  const d = makeDirs();
  const sid = '77777777-7777-7777-7777-777777777777';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus-4-8', {
      iterations: [
        { type: 'message', input_tokens: 1000, output_tokens: 200 },
        { type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 3000, output_tokens: 100 },
      ],
    }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  const ownUsage = r.dimensions.model.find((m) => m.key === 'claude-opus-4-8');
  const advisorUsage = r.dimensions.model.find((m) => m.key === 'claude-opus-4-8 (advisor)');
  assert.ok(ownUsage, 'normal usage of the model keeps its own row');
  assert.ok(advisorUsage, 'the consult on the same model gets its own row, not folded into the one above');
  assert.equal(r.dimensions.model.length, 2, 'exactly two rows, never merged into one');
  const expectedOwn = costUsd({ 'claude-opus-4-8': { input: 1000, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  const expectedAdvisor = costUsd({ 'claude-opus-4-8': { input: 3000, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  assert.ok(Math.abs(ownUsage.usd - expectedOwn) < 1e-9);
  assert.ok(Math.abs(advisorUsage.usd - expectedAdvisor) < 1e-9);
});

test('multiple message iterations with an advisor_message interspersed: nothing dropped or double-counted', async () => {
  const d = makeDirs();
  const sid = '55555555-5555-5555-5555-555555555555';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-sonnet-5', {
      iterations: [
        { type: 'message', input_tokens: 2, output_tokens: 1799 },
        { type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 104858, output_tokens: 14169 },
        { type: 'message', input_tokens: 2, output_tokens: 225 },
      ],
    }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  const expectedParent = costUsd({ 'claude-sonnet-5': { input: 4, output: 2024, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  const expectedAdvisor = costUsd({ 'claude-opus-4-8': { input: 104858, output: 14169, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  assert.ok(Math.abs(r.totals.usd - (expectedParent + expectedAdvisor)) < 1e-9);
  assert.ok(Math.abs(r.totals.advisorUsd - expectedAdvisor) < 1e-9);
});

test('transcript-reader and usage-report agree on usd/advisorUsd for the same multi-iteration turn', async () => {
  const d = makeDirs();
  const sid = '66666666-6666-6666-6666-666666666666';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-sonnet-5', {
      iterations: [
        { type: 'message', input_tokens: 2, output_tokens: 1799 },
        { type: 'advisor_message', model: 'claude-opus-4-8', input_tokens: 104858, output_tokens: 14169 },
        { type: 'message', input_tokens: 2, output_tokens: 225 },
      ],
    }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const fromTranscriptReader = await analyze(sid, d.projectsDir);
  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });

  assert.ok(Math.abs(fromTranscriptReader.usd - r.totals.usd) < 1e-9, 'both scanners agree on the headline total');
  assert.ok(Math.abs(fromTranscriptReader.advisorUsd - r.totals.advisorUsd) < 1e-9, 'both scanners agree on the advisor breakout');
});

// A live, unchanged file whose cached result predates the advisor-breakout field
// would otherwise serve a `daily` total computed under the old top-level-only
// read — silently missing the consult forever, since nothing else about the file
// ever invalidates the entry. Pins the `cached.result.advisor` gate.
test('a live file cached before advisorUsd existed is rescanned, not served stale', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';
  const file = claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-sonnet', {
      iterations: [
        { type: 'message', input_tokens: 1000, output_tokens: 200 },
        { type: 'advisor_message', model: 'claude-opus', input_tokens: 3000, output_tokens: 100 },
      ],
    }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const size = fs.statSync(file).size;
  const staleParentOnlyUsd = costUsd({ 'claude-sonnet': { input: 1000, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  fs.writeFileSync(path.join(d.dataDir, 'usage-scan-cache.json'), JSON.stringify({
    version: 3,
    claude: { [file]: { size, subSig: '', since: 0, result: {
      daily: { '2026-07-14T12': { 'claude-sonnet': { input: 1000, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } } },
      sub: {}, failed: false,
    } } },
    codex: {},
  }));

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(_usageFileCacheStats().misses, 1, 'the pre-advisor-shaped cache entry forced a rescan, not a stale hit');
  assert.ok(r.totals.advisorUsd > 0, 'the consult is no longer silently missing');
  assert.ok(r.totals.usd > staleParentOnlyUsd, 'the total grew once the consult was picked up');
});

test('dedups a resumed conversation shared by two card ids', async () => {
  const d = makeDirs();
  const sid = '33333333-3333-3333-3333-333333333333';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 1000, output_tokens: 1000 }, '2026-07-14T12:00:00.000Z'),
  ] });
  // Two cards resolve to the same transcript: the owner (liveSessionId === uuid) and
  // a resume that re-pointed a fresh card id at it.
  writeStores(d.dataDir, {
    entries: {
      owner: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' },
      resume: { agent: 'claude', liveSessionId: 'unrelated-live-id', cwd: '/work/proj' },
    },
  });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 1000, 'shared transcript counted once, not doubled');
});

test('attributes Codex spend to its createdAt day and flags it estimated', async () => {
  const d = makeDirs();
  const uuid = '44444444-4444-4444-4444-444444444444';
  const roll = path.join(d.codexSessionsDir, `rollout-2026-07-11T10-00-00-${uuid}.jsonl`);
  fs.writeFileSync(roll, [
    { timestamp: '2026-07-11T10:00:00.000Z', payload: { type: 'turn_context', model: 'gpt-5.5-codex' } },
    { timestamp: '2026-07-11T10:05:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 1000 } } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeStores(d.dataDir, { entries: {
    cx: { agent: 'codex', liveSessionId: uuid, cwd: '/work/proj', createdAt: '2026-07-11T09:59:00.000Z' },
  } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.estimatedIncluded, true);
  const day = r.buckets.find((b) => b.key === '2026-07-11');
  assert.ok(day, 'codex bucketed at createdAt day');
  assert.ok(day.total.estimatedUsd > 0);
  assert.equal(day.total.estimatedUsd, day.total.usd, 'all codex spend is estimated');
});

test('skips a Codex session with no usable createdAt without crashing', async () => {
  const d = makeDirs();
  const uuid = '55555555-5555-5555-5555-555555555555';
  const roll = path.join(d.codexSessionsDir, `rollout-2026-07-11T10-00-00-${uuid}.jsonl`);
  fs.writeFileSync(roll, [
    { timestamp: '2026-07-11T10:05:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 10 } } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeStores(d.dataDir, { entries: { cx: { agent: 'codex', liveSessionId: uuid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.usd, 0);
});

test('slices spend by model, labels ids, and orders models by spend', async () => {
  const d = makeDirs();
  const sid = '66666666-6666-6666-6666-666666666666';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus-4-20250514', { input_tokens: 100000, output_tokens: 100000 }, '2026-07-14T12:00:00.000Z'),
    turn('m2', 'claude-sonnet-4-20250514', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T13:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  // Full model id is the bucket key; the display name is the shortened label.
  assert.deepEqual(r.dimensions.model.map((m) => m.name), ['opus-4', 'sonnet-4'], 'ranked by spend, labels cleaned');
  const day = r.buckets.find((b) => b.key === '2026-07-14');
  assert.ok(day.byModel['claude-opus-4-20250514'].usd > day.byModel['claude-sonnet-4-20250514'].usd);
  // Per-model spend sums to the bucket total (same totals the $ costing walks).
  const modelSum = Object.values(day.byModel).reduce((a, m) => a + m.usd, 0);
  assert.ok(Math.abs(modelSum - day.total.usd) < 1e-9);
  assert.equal(day.byModel['claude-opus-4-20250514'].tokens.input, 100000);
});

test('disambiguates model labels that clean to the same name', async () => {
  const d = makeDirs();
  const sid = '6a6a6a6a-6a6a-6a6a-6a6a-6a6a6a6a6a6a';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus-4-20250514', { input_tokens: 100000, output_tokens: 100000 }, '2026-07-14T12:00:00.000Z'),
    turn('m2', 'claude-opus-4-20250801', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T13:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  // Both clean to "opus-4"; the display names must be distinct (stamped with the date)
  // while the filterable keys stay the full ids.
  const names = r.dimensions.model.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, 'no two chips share a display name');
  assert.deepEqual([...names].sort(), ['opus-4 (20250514)', 'opus-4 (20250801)']);
  assert.deepEqual(r.dimensions.model.map((m) => m.key).sort(),
    ['claude-opus-4-20250514', 'claude-opus-4-20250801'], 'keys remain the full ids');
});

test('slices by token type: $ uses costUsdByType and sums to the bucket total', async () => {
  const d = makeDirs();
  const sid = '77777777-7777-7777-7777-777777777777';
  const usage = { input_tokens: 100, output_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    cache_read_input_tokens: 5000 };
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-sonnet', usage, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.deepEqual(r.dimensions.type.map((t) => t.key), ['input', 'output', 'cacheWrite', 'cacheRead']);
  const day = r.buckets.find((b) => b.key === '2026-07-14');
  const expected = costUsdByType({ 'claude-sonnet': { input: 100, output: 200, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 5000 } });
  assert.ok(Math.abs(day.byType.input.usd - expected.input) < 1e-12);
  assert.ok(Math.abs(day.byType.cacheWrite.usd - expected.cacheWrite) < 1e-12);
  const typeSum = ['input', 'output', 'cacheWrite', 'cacheRead'].reduce((a, k) => a + day.byType[k].usd, 0);
  assert.ok(Math.abs(typeSum - day.total.usd) < 1e-9, '$ across the four types sums to the bucket total');
  // Tokens per type: each type cell carries only its own token count.
  assert.equal(day.byType.input.tokens.input, 100);
  assert.equal(day.byType.cacheWrite.tokens.cacheWrite, 3000);
  assert.equal(day.byType.cacheRead.tokens.cacheRead, 5000);
});

test('Codex carries a model bucket and estimated per-type spend', async () => {
  const d = makeDirs();
  const uuid = '88888888-8888-8888-8888-888888888888';
  const roll = path.join(d.codexSessionsDir, `rollout-2026-07-11T10-00-00-${uuid}.jsonl`);
  fs.writeFileSync(roll, [
    { timestamp: '2026-07-11T10:00:00.000Z', payload: { type: 'turn_context', model: 'gpt-5.5-codex' } },
    { timestamp: '2026-07-11T10:05:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 1000 } } } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeStores(d.dataDir, { entries: {
    cx: { agent: 'codex', liveSessionId: uuid, cwd: '/work/proj', createdAt: '2026-07-11T09:59:00.000Z' },
  } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.deepEqual(r.dimensions.model.map((m) => m.name), ['gpt-5.5-codex']);
  const day = r.buckets.find((b) => b.key === '2026-07-11');
  assert.ok(day.byModel['gpt-5.5-codex'].estimatedUsd > 0, 'codex model spend is flagged estimated');
  const typeSum = ['input', 'output', 'cacheWrite', 'cacheRead'].reduce((a, k) => a + day.byType[k].usd, 0);
  assert.ok(Math.abs(typeSum - day.total.usd) < 1e-9, 'codex $ across types sums to the bucket total');
});

test('window covers exactly the expected bucket count and ends at the current period', async () => {
  const d = makeDirs();
  writeStores(d.dataDir, { entries: {} });
  const scan = await scanAllDaily(d);
  assert.equal(rollup(scan, { granularity: 'day', now: NOW }).buckets.length, 30);
  assert.equal(rollup(scan, { granularity: 'week', now: NOW }).buckets.length, 12);
  const mo = rollup(scan, { granularity: 'month', now: NOW });
  assert.equal(mo.buckets.length, 12);
  assert.equal(mo.buckets.at(-1).key, '2026-07');
});

test('unknown granularity falls back to day', async () => {
  const d = makeDirs();
  writeStores(d.dataDir, { entries: {} });
  const scan = await scanAllDaily(d);
  assert.equal(rollup(scan, { granularity: 'annual', now: NOW }).granularity, 'day');
});

// ---- per-file scan cache ----------------------------------------------------

test('reuses a cached read for an unchanged file (no re-parse) across scans', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = '99999999-9999-9999-9999-999999999999';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  await scanAllDaily(d);
  assert.equal(_usageFileCacheStats().misses, 1, 'first scan reads the file');
  await scanAllDaily(d);
  const stats = _usageFileCacheStats();
  assert.equal(stats.misses, 1, 'second scan does not re-read an unchanged file');
  assert.equal(stats.hits, 1, 'second scan serves the cached result instead');
});

test('fully reparses a file that grew, picking up the new data', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0';
  const file = claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r1 = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r1.totals.tokens.input, 100);

  fs.appendFileSync(file, JSON.stringify(turn('m2', 'claude-opus', { input_tokens: 900, output_tokens: 0 }, '2026-07-15T12:00:00.000Z')) + '\n');

  const r2 = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r2.totals.tokens.input, 1000, 'the appended line is picked up on the next scan');
  assert.equal(_usageFileCacheStats().misses, 2, 'the grown file was reread, not served stale');
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
test('never caches a failed read — a corrupt file is retried every scan', { skip: isRoot ? 'chmod has no effect running as root' : false }, async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b0b0';
  const file = claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  fs.chmodSync(file, 0o000);
  try {
    const r1 = await buildUsage({ ...d, granularity: 'day', now: NOW });
    assert.equal(r1.failedFiles, 1, 'unreadable file is flagged failed, not silently $0');
  } finally {
    fs.chmodSync(file, 0o644);
  }

  const r2 = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r2.failedFiles, 0, 'once readable again, the retry succeeds — the earlier failure was never cached');
  assert.equal(r2.totals.tokens.input, 100);
});

test('survives a restart: a fresh in-memory cache reloads from the persisted disk cache', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  await scanAllDaily(d); // populates + persists the disk cache
  assert.ok(fs.existsSync(path.join(d.dataDir, 'usage-scan-cache.json')), 'the scan persists a disk cache file');

  _resetUsageFileCache(); // simulate a process restart: wipe in-memory state, keep disk

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 100, 'totals are correct after reloading from disk');
  assert.equal(_usageFileCacheStats().hits, 1, 'the unchanged file was served from the reloaded disk cache, not reread');
  assert.equal(_usageFileCacheStats().misses, 0);
});

test('discards a version-mismatched on-disk cache instead of trusting it', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0';
  const file = claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  fs.writeFileSync(path.join(d.dataDir, 'usage-scan-cache.json'), JSON.stringify({
    version: 999,
    claude: { [file]: { size: 999999, subSig: '', result: { daily: {}, sub: {}, failed: false } } },
    codex: {},
  }));

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 100, 'the stale-shaped cache was discarded, not trusted');
  assert.equal(_usageFileCacheStats().misses, 1, 'the file was read fresh, not served from the mismatched cache');
});

test('evicts a cache entry whose transcript is no longer referenced', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0';
  claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 100 }, '2026-07-14T12:00:00.000Z'),
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });
  await scanAllDaily(d);

  // The card is removed from mappings entirely (e.g. archived + pruned).
  writeStores(d.dataDir, { entries: {} });
  await scanAllDaily(d);

  // Re-adding the same entry afterwards must be treated as a fresh read, not a
  // stale hit from an evicted-then-resurrected cache entry.
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });
  await scanAllDaily(d);
  const stats = _usageFileCacheStats();
  assert.equal(stats.misses, 2, 'the entry was evicted while unreferenced, so re-adding it counted as a fresh read');
});

// Claude Code deletes its own transcripts past cleanupPeriodDays (~30) and the dashboard
// is the only surviving record of what they cost. So a costed, cached file must keep its
// history when it vanishes — on the scan that notices it's gone, on every LATER scan (the
// eviction loop is the failure mode that lost a whole month of real spend), and across a
// restart, where the answer has to come back off the persisted disk cache.
test('keeps a deleted transcript\'s cached history across rescans and a restart', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0';
  const file = claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 1000, output_tokens: 2000 }, '2026-07-10T12:00:00.000Z'),
    turn('m2', 'claude-opus', { input_tokens: 500, output_tokens: 100 }, '2026-07-12T09:00:00.000Z'),
  ] });
  writeStores(d.dataDir, {
    entries: { card1: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } },
    tasks: [{ id: 't1', name: 'Alpha' }], assignments: { card1: 't1' },
  });

  const scanned = async (label) => {
    const r = rollup(await scanAllDaily(d), { granularity: 'day', now: NOW });
    assert.equal(r.failedFiles, 0, `${label}: a deleted-but-cached file is not a failed read`);
    assert.equal(r.totals.tokens.input, 1500, `${label}: totals intact`);
    return Object.fromEntries(activeBuckets(r).map((b) => [b.key, b.total.tokens.input]));
  };
  const expected = { '2026-07-10': 1000, '2026-07-12': 500 };
  assert.deepEqual(await scanned('while the file exists'), expected);

  fs.rmSync(file); // the retention sweep

  assert.deepEqual(await scanned('the scan that notices the file is gone'), expected);
  assert.deepEqual(await scanned('a later scan, after the eviction loop has run once'), expected);

  _resetUsageFileCache(); // a restart: in-memory state wiped, the disk cache kept
  assert.deepEqual(await scanned('after a restart, reloaded from the disk cache'), expected);
  const stats = _usageFileCacheStats();
  assert.equal(stats.hits, 1, 'the vanished file was served from the cache, not read');
  assert.equal(stats.misses, 0);

  const r = rollup(await scanAllDaily(d), { granularity: 'day', now: NOW });
  assert.deepEqual(r.tasks.map((t) => t.name), ['Alpha'], 'still attributed to its task');
});

// The other half: a transcript deleted before anything ever costed it is genuinely
// unrecoverable, and must degrade exactly as it did before the deterministic-path
// fallback existed — no spend, no crash, and NOT a phantom read that inflates the
// failedFiles banner (every long-archived session on a real board looks like this).
test('a transcript deleted before it was ever scanned stays unresolved', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1';
  writeStores(d.dataDir, { entries: { card1: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.usd, 0);
  assert.equal(r.totals.tokens.input, 0);
  assert.equal(r.failedFiles, 0, 'an unresolved session is skipped, not reported as a broken file');
  assert.deepEqual(r.tasks, []);
  assert.equal(_usageFileCacheStats().misses, 0, 'no phantom path was read');
});

const readCache = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'usage-scan-cache.json'), 'utf8'));

// The cache outlives its transcript, so its resolution is the ceiling on every view that
// can ever be built from deleted history. Pin it at per-hour, per-model, RAW TOKENS: an
// hourly breakdown stays possible, and spend can be re-priced later because nothing was
// pre-costed into $. Coarsening or pre-costing this is unrecoverable, not just lossy.
test('caches raw per-model tokens at hour resolution, so any coarser view is derivable', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
  const file = claudeTranscript(d.projectsDir, { sessionId: sid, lines: [
    turn('m1', 'claude-opus', { input_tokens: 100, output_tokens: 1 }, '2026-07-10T09:15:00.000Z'),
    turn('m2', 'claude-opus', { input_tokens: 20, output_tokens: 1 }, '2026-07-10T09:45:00.000Z'), // same hour
    turn('m3', 'claude-sonnet', { input_tokens: 3, output_tokens: 1 }, '2026-07-10T14:05:00.000Z'), // same day, later hour
  ] });
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = rollup(await scanAllDaily(d), { granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 123, 'the day view still sums every hour');

  const entry = readCache(d.dataDir).claude[file];
  assert.deepEqual(Object.keys(entry.result.daily).sort(), ['2026-07-10T09', '2026-07-10T14'],
    'distinct hours are kept apart; turns within one hour merge');
  assert.deepEqual(entry.result.daily['2026-07-10T09'], {
    'claude-opus': { input: 120, output: 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  }, 'raw per-model token counts, not costed dollars');
  assert.equal(Object.keys(entry.result.daily['2026-07-10T14'])[0], 'claude-sonnet', 'models stay separable per hour');
});

// Bumping the cache version DISCARDS the whole blob, and for a transcript Claude Code has
// already deleted that blob is the only record of the spend that exists — so the hour-key
// bump has to read the old day-keyed shape rather than throw it away. This is the exact
// shape of the ~270 real entries (June included) on a live board at the time of the bump.
test('reads a legacy day-keyed cache entry instead of discarding the history', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2';
  const file = path.join(d.projectsDir, '-work-proj', `${sid}.jsonl`); // transcript long since deleted
  fs.writeFileSync(path.join(d.dataDir, 'usage-scan-cache.json'), JSON.stringify({
    version: 2, // the pre-hour-bucket shape: keys are bare days
    claude: { [file]: { size: 100, subSig: '', since: 0, result: {
      daily: { '2026-07-10': { 'claude-opus': { input: 4000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } } },
      sub: {}, failed: false,
    } } },
    codex: {},
  }));
  writeStores(d.dataDir, { entries: { c: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 4000, 'v2 history survives the version bump');
  assert.equal(activeBuckets(r)[0].key, '2026-07-10', 'a bare day key still lands on its day');
  assert.equal(r.failedFiles, 0);
});

// A cache entry costed under a DIFFERENT fork bound can't be served (the bound is stored
// but is not part of the key — the key is the file, which two card ids can share), so
// resolving to the vanished path would only produce a read that fails. Same outcome as
// never having cached it: unresolved, and never a phantom failed read.
test('a deleted transcript cached under a different fork bound is not resurrected', async () => {
  _resetUsageFileCache();
  const d = makeDirs();
  const sid = 'f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2';
  const file = path.join(d.projectsDir, '-work-proj', `${sid}.jsonl`); // the file itself is already gone
  fs.writeFileSync(path.join(d.dataDir, 'usage-scan-cache.json'), JSON.stringify({
    version: 2,
    claude: { [file]: { size: 100, subSig: '', since: Date.parse('2026-07-01T00:00:00.000Z'), result: {
      daily: { '2026-07-10': { 'claude-opus': { input: 1000, output: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } } },
      sub: {}, failed: false,
    } } },
    codex: {},
  }));
  // The entry is NOT a fork, so its bound is 0 — it can never match the cached entry's.
  writeStores(d.dataDir, { entries: { card1: { agent: 'claude', liveSessionId: sid, cwd: '/work/proj' } } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  assert.equal(r.totals.tokens.input, 0, 'a result costed under another bound is not claimed');
  assert.equal(r.failedFiles, 0, 'and it is not turned into a phantom failed read either');
});

// A fork's transcript is a verbatim replay of the parent's history plus its own turns
// (see transcript-reader.js scanLine). The per-transcript-file dedup below does NOT
// catch it — a fork is a genuinely new file — so without a fork bound the dashboard
// bills the same parent turns on both cards and the month total is inflated.
test('a fork contributes only its own post-fork turns, so the parent is not billed twice', async () => {
  const d = makeDirs();
  const parentSid = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const forkSid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const inheritedTurn = turn('p1', 'claude-opus', { input_tokens: 8000, output_tokens: 900 }, '2026-07-10T12:00:00.000Z');
  const forkOwnTurn = turn('f1', 'claude-opus', { input_tokens: 1000, output_tokens: 100 }, '2026-07-12T15:00:00.000Z');
  claudeTranscript(d.projectsDir, { sessionId: parentSid, lines: [inheritedTurn] });
  // The replay: byte-identical parent lines, then the fork's own turn.
  claudeTranscript(d.projectsDir, { sessionId: forkSid, lines: [inheritedTurn, forkOwnTurn] });
  writeStores(d.dataDir, { entries: {
    parentCard: { agent: 'claude', liveSessionId: parentSid, cwd: '/work/proj', createdAt: Date.parse('2026-07-10T11:00:00.000Z') },
    forkCard: { agent: 'claude', liveSessionId: forkSid, cwd: '/work/proj', forkedFrom: 'parentCard', createdAt: Date.parse('2026-07-12T14:00:00.000Z') },
  } });

  const r = await buildUsage({ ...d, granularity: 'day', now: NOW });
  const byDay = Object.fromEntries(r.buckets.map((b) => [b.key, b.total.tokens.input]));
  assert.equal(byDay['2026-07-10'], 8000, 'the parent turn is billed once, on the parent');
  assert.equal(byDay['2026-07-12'], 1000, "only the fork's own turn lands on the fork day");
  assert.equal(r.totals.tokens.input, 9000, 'total must not double-count the replayed history');
});
