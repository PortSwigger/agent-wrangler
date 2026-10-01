import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncCodexLedger, flushCodexLedger, _resetCodexLedger, LEDGER_FILE, CURSOR_FILE } from './codex-usage-ledger.js';

beforeEach(() => _resetCodexLedger());

const u = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const tc = (ts, total, last, ord) => ({ timestamp: ts, ordinal: ord, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const ctx = (ts, model, ord) => ({ timestamp: ts, ordinal: ord, type: 'turn_context', payload: { model, effort: 'high', turn_id: 'turn' } });
const jl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cxl-'));
  const sessions = path.join(root, 'sessions');
  const archived = path.join(root, 'archived');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(sessions, '2026', '09', '01'), { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const file = (name) => path.join(sessions, '2026', '09', '01', name);
  const sync = (opts = {}) => syncCodexLedger({ dataDir, roots: [sessions, archived], ...opts });
  return { root, sessions, archived, dataDir, file, sync };
}

const T1 = 'aaaaaaaa-0000-7000-8000-000000000001';
const R2 = 'bbbbbbbb-0000-7000-8000-000000000002';

function threadTotal(ledger, threadId) {
  const { threads } = ledger.threadIndex();
  let total = 0;
  for (const name of threads.get(threadId).rollouts) for (const e of ledger.rolloutEntries(name)) total += e.d.total;
  return total;
}

test('leaves a partial final line for the next pass and picks it up once complete', async () => {
  const s = setup();
  const f = s.file(`rollout-2026-09-01T10-00-00-${T1}.jsonl`);
  const head = jl([
    { timestamp: '2026-09-01T10:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: T1 } },
    ctx('2026-09-01T10:00:01.000Z', 'gpt-6-sol', 1),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100), 2),
  ]);
  const torn = JSON.stringify(tc('2026-09-01T10:01:05.000Z', u(3000, 0, 300), u(2000, 0, 200), 3));
  fs.writeFileSync(f, head + torn.slice(0, 40));
  let ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 1100);
  fs.writeFileSync(f, head + torn + '\n');
  ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 3300);
  assert.equal(ledger.threadHealth(ledger.threadIndex().threads.get(T1)).status, 'ok');
});

test('byte cursors stay correct across multibyte UTF-8 content', async () => {
  const s = setup();
  const f = s.file(`rollout-2026-09-01T10-00-00-${T1}.jsonl`);
  const first = jl([
    { timestamp: '2026-09-01T10:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: T1 } },
    { timestamp: '2026-09-01T10:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'héllo — 日本語 🚀'.repeat(50) } },
    ctx('2026-09-01T10:00:01.000Z', 'gpt-6-sol', 1),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100), 2),
  ]);
  fs.writeFileSync(f, first);
  await s.sync();
  fs.appendFileSync(f, jl([tc('2026-09-01T10:01:05.000Z', u(3000, 0, 300), u(2000, 0, 200), 3)]));
  const ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 3300);
  assert.equal(ledger.threadHealth(ledger.threadIndex().threads.get(T1)).status, 'ok');
});

function resumedThread(s, { withBase = true } = {}) {
  if (withBase) {
    fs.writeFileSync(s.file(`rollout-2026-09-01T10-00-00-${T1}.jsonl`), jl([
      { timestamp: '2026-09-01T10:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: T1 } },
      ctx('2026-09-01T10:00:01.000Z', 'gpt-6-sol', 1),
      tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100), 2),
      tc('2026-09-01T10:00:09.000Z', u(3000, 0, 300), u(2000, 0, 200), 3),
      // The original kept running after the resume branched at ordinal 4.
      tc('2026-09-01T11:00:00.000Z', u(7000, 0, 700), u(4000, 0, 400), 4),
    ]));
  }
  fs.writeFileSync(s.file(`rollout-2026-09-02T09-00-00-${T1}_${R2}.jsonl`), jl([
    { timestamp: '2026-09-02T09:00:00.000Z', ordinal: 4, type: 'session_meta', payload: { id: T1, history_base: { thread_id: T1, end_ordinal_exclusive: 4 } } },
    ctx('2026-09-02T09:00:01.000Z', 'gpt-6-sol', 5),
    tc('2026-09-02T09:00:05.000Z', u(3500, 0, 350), u(500, 0, 50), 6),
  ]));
}

test('a resumed thread counts both files once, including usage the original made after the branch', async () => {
  const s = setup();
  resumedThread(s);
  const ledger = await s.sync();
  const thread = ledger.threadIndex().threads.get(T1);
  assert.equal(thread.rollouts.length, 2);
  assert.equal(threadTotal(ledger, T1), 7700 + 550);
  const health = ledger.threadHealth(thread);
  assert.equal(health.status, 'ok', JSON.stringify(health));
  assert.equal(ledger.threadIndex().aliases.get(R2), T1);
});

test('a resume whose earlier file the ledger never saw is incomplete, with its base unattributed', async () => {
  const s = setup();
  resumedThread(s, { withBase: false });
  const ledger = await s.sync();
  const health = ledger.threadHealth(ledger.threadIndex().threads.get(T1));
  assert.equal(health.status, 'incomplete');
  assert.deepEqual(health.reasons, ['resume-base-missing']);
  assert.equal(health.unattributed.total, 3300);
});

test('a resume whose starting value disagrees with the original at the branch point is a mismatch', async () => {
  const s = setup();
  resumedThread(s);
  const f = s.file(`rollout-2026-09-02T09-00-00-${T1}_${R2}.jsonl`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"input_tokens":3500', '"input_tokens":3900'));
  const ledger = await s.sync();
  assert.equal(ledger.threadHealth(ledger.threadIndex().threads.get(T1)).status, 'mismatch');
});

test('usage survives deletion of the rollout and a fresh process', async () => {
  const s = setup();
  resumedThread(s);
  let ledger = await s.sync();
  ledger.attach(T1, { cardId: 'card-1', task: { key: 't1', name: 'Task one' }, launches: [{ at: 1, mode: 'chatgpt' }] });
  flushCodexLedger(ledger);
  fs.rmSync(s.sessions, { recursive: true, force: true });
  _resetCodexLedger();
  ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 8250);
  assert.equal(ledger.attachments.get(T1).cardId, 'card-1');
  assert.equal(ledger.threadHealth(ledger.threadIndex().threads.get(T1)).status, 'ok');
});

test('a lost cursor file rescans without double-counting', async () => {
  const s = setup();
  resumedThread(s);
  await s.sync();
  fs.rmSync(path.join(s.dataDir, CURSOR_FILE));
  _resetCodexLedger();
  const ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 8250);
});

test('moving a rollout into the archive does not count it again', async () => {
  const s = setup();
  resumedThread(s);
  await s.sync();
  const name = `rollout-2026-09-01T10-00-00-${T1}.jsonl`;
  fs.renameSync(s.file(name), path.join(s.archived, name));
  const ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 8250);
});

test('a rollout rewritten under the cursor is rescanned from zero, replacing its rows', async () => {
  const s = setup();
  const f = s.file(`rollout-2026-09-01T10-00-00-${T1}.jsonl`);
  const lines = [
    { timestamp: '2026-09-01T10:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: T1 } },
    ctx('2026-09-01T10:00:01.000Z', 'gpt-6-sol', 1),
    tc('2026-09-01T10:00:05.000Z', u(1000, 0, 100), u(1000, 0, 100), 2),
  ];
  fs.writeFileSync(f, jl(lines));
  await s.sync();
  lines[2] = tc('2026-09-01T10:00:05.000Z', u(1200, 0, 100), u(1200, 0, 100), 2);
  fs.writeFileSync(f, jl(lines) + jl([tc('2026-09-01T10:00:09.000Z', u(2200, 0, 200), u(1000, 0, 100), 3)]));
  let ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 2400);
  _resetCodexLedger();
  ledger = await s.sync();
  assert.equal(threadTotal(ledger, T1), 2400);
});

test('persist:false syncs in memory and writes nothing', async () => {
  const s = setup();
  resumedThread(s);
  const ledger = await s.sync({ persist: false });
  assert.equal(threadTotal(ledger, T1), 8250);
  assert.equal(fs.existsSync(path.join(s.dataDir, LEDGER_FILE)), false);
});

test('a torn final ledger row from a crash is skipped and never glued to the next append', async () => {
  const s = setup();
  resumedThread(s);
  await s.sync();
  fs.appendFileSync(path.join(s.dataDir, LEDGER_FILE), '{"t":"e","r":"x","id":"tor');
  _resetCodexLedger();
  let ledger = await s.sync();
  ledger.attach(T1, { cardId: 'card-1', task: { key: 't', name: 'T' } });
  flushCodexLedger(ledger);
  _resetCodexLedger();
  ledger = await s.sync();
  assert.equal(ledger.attachments.get(T1).cardId, 'card-1');
  assert.equal(threadTotal(ledger, T1), 8250);
});

test('mixed legacy and current rollouts both reconcile', async () => {
  const s = setup();
  const legacy = 'cccccccc-0000-4000-8000-000000000003';
  fs.writeFileSync(s.file(`rollout-2026-06-01T10-00-00-${legacy}.jsonl`), jl([
    { type: 'session_meta', payload: { id: legacy } },
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(1000, 0, 100) } } },
  ]));
  resumedThread(s);
  const ledger = await s.sync();
  const { threads } = ledger.threadIndex();
  assert.equal(ledger.threadHealth(threads.get(legacy)).status, 'ok');
  assert.equal(ledger.threadHealth(threads.get(T1)).status, 'ok');
  assert.equal(threadTotal(ledger, legacy), 1100);
});

test('overlapping syncs share one ledger and keep its totals', async () => {
  const s = setup();
  resumedThread(s);
  const [a, b] = await Promise.all([s.sync(), s.sync()]);
  assert.equal(a, b);
  assert.equal(threadTotal(a, T1), 8250);
  _resetCodexLedger();
  assert.equal(threadTotal(await s.sync(), T1), 8250);
});
