import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexLiveStatus, codexStatus, IN_FLIGHT_STALE_MS } from './codex-status.js';
import { writeTurnRecord } from '../codex-turns.js';

const t = (s) => Date.parse(s);
const fresh = (over) => ({ startedAt: null, completedAt: null, abortedAt: null, mtimeMs: t('2026-10-21T22:04:20Z'), ...over });
const now = t('2026-10-21T22:04:24Z');

test('codexLiveStatus: a pane idle during an in-flight turn is working (the 21 Oct case)', () => {
  const marks = fresh({ startedAt: t('2026-10-21T21:40:00Z'), completedAt: t('2026-10-21T21:39:00Z') });
  assert.equal(codexLiveStatus({ paneStatus: 'idle', marks, turnEnd: null, now }), 'working');
});

test('codexLiveStatus: the notify record ends the turn', () => {
  const marks = fresh({ startedAt: t('2026-10-21T22:04:00Z') });
  const turnEnd = { threadId: 'x', turnId: 'u', endedAt: t('2026-10-21T22:04:10Z'), lastAssistantMessage: 'done', cwd: '/w' };
  assert.equal(codexLiveStatus({ paneStatus: 'idle', marks, turnEnd, now }), 'idle');
});

test('codexLiveStatus: an Esc abort ends the turn without a notify record', () => {
  const marks = fresh({ startedAt: t('2026-10-21T22:04:00Z'), abortedAt: t('2026-10-21T22:04:10Z') });
  assert.equal(codexLiveStatus({ paneStatus: 'idle', marks, turnEnd: null, now }), 'idle');
});

test('codexLiveStatus: stale in-flight turn falls back to the pane', () => {
  const marks = fresh({ startedAt: t('2026-10-21T21:00:00Z'), mtimeMs: t('2026-10-21T21:00:00Z') });
  assert.ok(now - marks.mtimeMs > IN_FLIGHT_STALE_MS);
  assert.equal(codexLiveStatus({ paneStatus: 'idle', marks, turnEnd: null, now }), 'idle');
  assert.equal(codexLiveStatus({ paneStatus: 'unknown', marks, turnEnd: null, now }), 'idle');
});

test('codexLiveStatus: pane working, needs-you and dialogs win', () => {
  for (const s of ['working', 'needs-you']) assert.equal(codexLiveStatus({ paneStatus: s, marks: fresh(), turnEnd: null, now }), s);
});

test('codexLiveStatus: unknown pane with no marks stays unknown', () => {
  assert.equal(codexLiveStatus({ paneStatus: 'unknown', marks: fresh(), turnEnd: null, now }), 'unknown');
});

function sessionsWithRollout(sid, lines) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-sessions-'));
  const day = path.join(sessionsDir, '2026', '10', '21');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-10-21T22-00-00-${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return sessionsDir;
}

const mark = (type, timestamp) => ({ timestamp, type: 'event_msg', payload: { type, turn_id: 'u' } });

test('codexStatus ignores a record for another thread', async () => {
  const main = '11111111-1111-4111-8111-111111111111';
  const now = Date.now();
  const sessionsDir = sessionsWithRollout(main, [mark('task_started', new Date(now - 5000).toISOString())]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-data-'));
  await writeTurnRecord({ threadId: 'title-thread', turnId: 'u', endedAt: now - 1000, lastAssistantMessage: 'title', cwd: '/w' }, dataDir);
  const r = await codexStatus({ liveSid: main, paneText: 'quiet prompt', now, dataDir, sessionsDir });
  assert.equal(r.status, 'working');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('codexStatus: the record for the live thread ends the turn', async () => {
  const main = '22222222-2222-4222-8222-222222222222';
  const now = Date.now();
  const sessionsDir = sessionsWithRollout(main, [mark('task_started', new Date(now - 5000).toISOString())]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-data-'));
  await writeTurnRecord({ threadId: main, turnId: 'u', endedAt: now - 1000, lastAssistantMessage: 'done', cwd: '/w' }, dataDir);
  const r = await codexStatus({ liveSid: main, paneText: 'quiet prompt', now, dataDir, sessionsDir });
  assert.equal(r.status, 'idle');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('codexStatus: an empty capture is unknown, not idle', async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-sessions-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-data-'));
  assert.deepEqual(await codexStatus({ liveSid: 'nope', paneText: '', dataDir, sessionsDir }), { status: 'unknown', waitingFor: null });
  assert.deepEqual(await codexStatus({ liveSid: null, paneText: '', dataDir, sessionsDir }), { status: 'unknown', waitingFor: null });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('codexStatus passes the pane hint through', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-data-'));
  const r = await codexStatus({ liveSid: null, paneText: 'Do you trust the contents of this directory?\n  1. Yes, continue\n  2. No, quit\nPress enter to continue', dataDir });
  assert.equal(r.status, 'needs-you');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
