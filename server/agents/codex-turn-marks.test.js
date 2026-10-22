import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTurnMarks, readTurnMarks } from './codex-turn-marks.js';

const line = (timestamp, type, extra = {}) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type, turn_id: 'u', ...extra } });
const started = (t) => line(t, 'task_started');
const complete = (t) => line(t, 'task_complete', { last_agent_message: 'ok' });
const aborted = (t) => line(t, 'turn_aborted', { reason: 'interrupted' });
const t = (s) => Date.parse(s);

test('parseTurnMarks returns the latest mark of each kind', () => {
  const text = [started('2026-10-22T11:08:31.140Z'), complete('2026-10-22T11:08:33.695Z'), started('2026-10-22T11:10:00.000Z'), aborted('2026-10-22T11:10:05.000Z'), started('2026-10-22T11:12:00.000Z')].join('\n');
  assert.deepEqual(parseTurnMarks(text), { startedAt: t('2026-10-22T11:12:00.000Z'), completedAt: t('2026-10-22T11:08:33.695Z'), abortedAt: t('2026-10-22T11:10:05.000Z') });
});

test('parseTurnMarks ignores other records and malformed lines', () => {
  const text = ['not json', JSON.stringify({ timestamp: '2026-10-22T11:00:00.000Z', type: 'response_item', payload: { type: 'task_started' } }), started('2026-10-22T11:01:00.000Z')].join('\n');
  assert.deepEqual(parseTurnMarks(text), { startedAt: t('2026-10-22T11:01:00.000Z'), completedAt: null, abortedAt: null });
});

test('readTurnMarks ignores a truncated leading line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-marks-'));
  const file = path.join(dir, 'rollout.jsonl');
  const filler = JSON.stringify({ timestamp: '2026-10-22T10:00:00.000Z', type: 'response_item', payload: { type: 'message', text: 'y'.repeat(400) } });
  const tail = [complete('2026-10-22T11:08:33.695Z'), started('2026-10-22T11:12:00.000Z')].join('\n');
  fs.writeFileSync(file, `${started('2026-10-22T09:00:00.000Z')}\n${filler}\n${filler}\n${tail}\n`);
  const marks = await readTurnMarks(file, { tailBytes: tail.length + 100 });
  assert.equal(marks.startedAt, t('2026-10-22T11:12:00.000Z'));
  assert.equal(marks.completedAt, t('2026-10-22T11:08:33.695Z'));
  assert.equal(marks.abortedAt, null);
  assert.equal(marks.mtimeMs, fs.statSync(file).mtimeMs);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTurnMarks finds a turn start that fell outside the tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-marks-'));
  const file = path.join(dir, 'rollout.jsonl');
  const output = JSON.stringify({ timestamp: '2026-10-22T11:13:00.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'z'.repeat(5000) } });
  fs.writeFileSync(file, `${complete('2026-10-22T11:00:00.000Z')}\n${started('2026-10-22T11:12:00.000Z')}\n${output}\n`);
  const marks = await readTurnMarks(file, { tailBytes: 1000 });
  assert.equal(marks.startedAt, t('2026-10-22T11:12:00.000Z'));
  assert.equal(marks.completedAt, t('2026-10-22T11:00:00.000Z'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTurnMarks gives up widening at maxBytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-marks-'));
  const file = path.join(dir, 'rollout.jsonl');
  const output = JSON.stringify({ timestamp: '2026-10-22T11:13:00.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'z'.repeat(5000) } });
  fs.writeFileSync(file, `${started('2026-10-22T11:12:00.000Z')}\n${output}\n`);
  const marks = await readTurnMarks(file, { tailBytes: 1000, maxBytes: 2000 });
  assert.equal(marks.startedAt, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTurnMarks on a missing file is all null', async () => {
  assert.deepEqual(await readTurnMarks('/nonexistent'), { startedAt: null, completedAt: null, abortedAt: null, mtimeMs: null });
});
