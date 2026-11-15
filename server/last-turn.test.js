import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeLines } from './transcript-reader.js';
import { readLastTurn } from './last-turn.js';
import { projectSession } from './host-api/project.js';

const stamp = '2026-11-15T10:00:00.000Z';
const at = Date.parse(stamp);
const claude = (message, extra = {}) => JSON.stringify({ type: message.role, timestamp: stamp, message, ...extra });

test('Claude exposes success, provider failure, interruption and subsequent progress', () => {
  const ok = claude({ role: 'assistant', stop_reason: 'end_turn', content: [] });
  const error = claude({ role: 'assistant', content: [] }, { isApiErrorMessage: true, error: 'server_error' });
  const aborted = claude({ role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] });
  const progress = claude({ role: 'assistant', stop_reason: 'tool_use', content: [] });
  assert.deepEqual(analyzeLines([ok]).lastTurn, { outcome: 'ok', at });
  assert.deepEqual(analyzeLines([error]).lastTurn, { outcome: 'error', errorKind: 'server_error', at });
  assert.deepEqual(analyzeLines([aborted]).lastTurn, { outcome: 'aborted', at });
  for (const end of [ok, error, aborted]) {
    assert.equal(analyzeLines([end, progress]).lastTurn, null);
    assert.equal(analyzeLines([end, claude({ role: 'user', content: 'continue' })]).lastTurn, null);
    assert.deepEqual(analyzeLines([end, claude({ role: 'assistant', content: [] }, { isSidechain: true })]).lastTurn, analyzeLines([end]).lastTurn);
  }
  assert.equal(analyzeLines([ok], { since: at + 1 }).lastTurn, null);
  assert.equal(analyzeLines([claude({ role: 'assistant', stop_reason: 'end_turn' }, { timestamp: 'invalid' })]).lastTurn, null);
});

test('Codex reads terminal marks and clears them when another turn starts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-last-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = '11111111-1111-4111-8111-111111111111';
  const file = path.join(dir, `rollout-2026-11-15T10-00-00-${sid}.jsonl`);
  const mark = (type, timestamp = stamp, extra = {}) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type, ...extra } });
  for (const [type, outcome, extra] of [['task_complete', 'ok', {}], ['turn_aborted', 'aborted', {}], ['error', 'error', { codex_error_info: 'usage_limit_exceeded' }]]) {
    fs.writeFileSync(file, mark(type, stamp, extra) + '\n');
    const expected = { outcome, at, ...(outcome === 'error' ? { errorKind: 'usage_limit_exceeded' } : {}) };
    assert.deepEqual(await readLastTurn('codex', sid, null, { sessionsDir: dir }), expected);
    fs.appendFileSync(file, mark('task_started', '2026-11-15T10:01:00.000Z') + '\n');
    assert.equal(await readLastTurn('codex', sid, null, { sessionsDir: dir }), null);
  }
  assert.equal(await readLastTurn('codex', 'missing', null, { sessionsDir: dir }), null);
});

test('the host projects a copied, frozen outcome and suppresses stale turns on progress or relaunch', () => {
  const lastTurn = { outcome: 'aborted', at, secret: 'private' };
  const node = { status: 'idle', lastTurn };
  const p = projectSession({}, 'card', { node });
  assert.deepEqual(p.lastTurn, { outcome: 'aborted', at });
  assert.ok(Object.isFrozen(p.lastTurn));
  assert.equal(Object.isFrozen(lastTurn), false);
  assert.equal(projectSession({}, 'card').lastTurn, null);
  assert.equal(projectSession({}, 'card', { node: { ...node, status: 'working' } }).lastTurn, null);
  assert.equal(projectSession({ relaunchedAt: at + 1 }, 'card', { node }).lastTurn, null);
});
