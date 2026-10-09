import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ScheduleStore } from './schedule-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const start = source.indexOf('async function fireSchedule(');
const end = source.indexOf('\n}\n', start) + 2;
const declaration = source.slice(start, end);

for (const [label, action, expectedFocus] of [
  ['focused existing session', { kind: 'session', sessionId: 'CARD1', focus: true }, true],
  ['unfocused existing session', { kind: 'session', sessionId: 'CARD1' }, false],
  ['new session', { kind: 'dispatch', dispatch: {} }, false],
]) {
  test(`successful ${label} schedule broadcasts its focus choice`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-schedule-focus-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const scheduleStore = new ScheduleStore(path.join(dir, 'schedules.json'));
    const schedule = scheduleStore.create({ when: { kind: 'once', runAt: '2026-10-10T09:00:00Z' }, action }, Date.now());
    const messages = [];
    const fire = new Function('scheduleStore', 'performScheduleAction', 'broadcast', `${declaration}; return fireSchedule;`)(
      scheduleStore, async () => ({ sessionId: 'CARD1' }), (msg) => messages.push(msg),
    );
    await fire(schedule.id, { manual: true });
    assert.equal(messages[0].type, 'schedule-fired');
    assert.equal(messages[0].sessionId, 'CARD1');
    assert.equal(messages[0].focus, expectedFocus);
    assert.equal(scheduleStore.snapshot().schedules[0].enabled, true);
  });
}

test('failed focused schedule broadcasts only an error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-schedule-focus-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scheduleStore = new ScheduleStore(path.join(dir, 'schedules.json'));
  const schedule = scheduleStore.create({ when: { kind: 'once', runAt: '2026-10-10T09:00:00Z' }, action: { kind: 'session', sessionId: 'CARD1', focus: true } }, Date.now());
  const messages = [];
  const fire = new Function('scheduleStore', 'performScheduleAction', 'broadcast', `${declaration}; return fireSchedule;`)(
    scheduleStore, async () => { throw new Error('Target gone'); }, (msg) => messages.push(msg),
  );
  await fire(schedule.id);
  assert.deepEqual(messages, [{ type: 'schedule-error', id: schedule.id, name: schedule.name, message: 'Target gone' }]);
});
