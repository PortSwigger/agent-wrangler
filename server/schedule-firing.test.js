import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduleStore } from './schedule-store.js';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

function harness(t, action, rebuild = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-schedule-firing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-16T09:00:00Z');
  const file = path.join(dir, 'schedules.json');
  const store = new ScheduleStore(file);
  const create = (when = { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }) => store.create({ when, dispatch: {} }, now - 1000);
  const messages = [];
  let calls = 0;
  let rebuilds = 0;
  const guard = source.match(/let schedulesTickInFlight = false;/)?.[0] || '';
  const runner = new Function('scheduleStore', 'performScheduleAction', 'broadcast', 'sessionManager', 'sessionLabel', 'rebuild', 'STALE_MS', 'Date',
    `${guard}\n${declaration('fireSchedule')}\n${declaration('fireDueSchedules')}\nreturn { fireSchedule, fireDueSchedules };`)(
    store, (...args) => { calls++; return action(...args); }, (msg) => messages.push(msg),
    { entryFor: () => null }, ({ fallback }) => fallback, async () => { rebuilds++; await rebuild(); }, 3600000,
    class extends Date { static now() { return now; } },
  );
  return { ...runner, store, create, messages, get calls() { return calls; }, get rebuilds() { return rebuilds; },
    reload: () => new ScheduleStore(file), advance: (ms) => { now += ms; } };
}

for (const kind of ['cron', 'once']) {
  test(`slow ${kind} launch consumes its slot before completion`, async (t) => {
    let finish;
    const h = harness(t, () => new Promise((resolve) => { finish = resolve; }));
    const s = h.create(kind === 'once' ? { kind: 'once', runAt: '2026-11-16T09:00:00Z' } : undefined);
    const first = h.fireDueSchedules();
    assert.equal(h.reload().due(Date.parse('2026-11-16T09:00:00Z')).length, 0);
    for (let i = 0; i < 3; i++) {
      h.advance(30000);
      await h.fireDueSchedules();
    }
    assert.equal(h.calls, 1);
    finish({ sessionId: 'SESSION' });
    await first;
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].type, 'schedule-fired');
    const saved = h.store.snapshot().schedules.find((x) => x.id === s.id);
    if (kind === 'cron') assert.equal(saved.lastSessionId, 'SESSION');
    else assert.equal(saved, undefined);
  });
}

test('overlapping wake ticks process the due batch once, including failures', async (t) => {
  let fail;
  const h = harness(t, () => new Promise((_resolve, reject) => { fail = reject; }));
  h.create();
  h.create();
  const first = h.fireDueSchedules();
  const overlapping = [h.fireDueSchedules(), h.fireDueSchedules(), h.fireDueSchedules()];
  assert.equal(h.calls, 1);
  await Promise.all(overlapping);
  fail(new Error('Startup unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls, 2);
  fail(new Error('Startup unavailable'));
  await first;
  await h.fireDueSchedules();
  assert.equal(h.calls, 2);
  assert.deepEqual(h.messages.map((msg) => [msg.type, msg.message]), [
    ['schedule-error', 'Startup unavailable'], ['schedule-error', 'Startup unavailable'],
  ]);
  assert.equal(h.rebuilds, 1);
});

test('manual runs preserve the next automatic slot on success and failure', async (t) => {
  let failing = false;
  const h = harness(t, async () => {
    if (failing) throw new Error('Unavailable');
    return { sessionId: 'MANUAL' };
  });
  const s = h.create();
  await h.fireSchedule(s.id, { manual: true });
  assert.equal(h.store.snapshot().schedules[0].nextRunAt, s.nextRunAt);
  failing = true;
  await h.fireSchedule(s.id, { manual: true });
  assert.equal(h.store.snapshot().schedules[0].nextRunAt, s.nextRunAt);
  assert.equal(h.store.snapshot().schedules[0].enabled, true);
});

test('sweep guard is released when rebuilding fails', async (t) => {
  let failing = true;
  const h = harness(t, async () => ({ sessionId: 'SESSION' }), async () => {
    if (failing) throw new Error('Rebuild unavailable');
  });
  h.create();
  await assert.rejects(h.fireDueSchedules(), /Rebuild unavailable/);
  failing = false;
  h.advance(86400000);
  await h.fireDueSchedules();
  assert.equal(h.calls, 2);
});

for (const kind of ['cron', 'once']) {
  test(`hung ${kind} launch times out, continues the batch and releases later ticks`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish;
    let first = true;
    const h = harness(t, () => {
      if (first) {
        first = false;
        return new Promise((resolve) => { finish = resolve; });
      }
      return Promise.resolve({ sessionId: 'HEALTHY' });
    });
    const stuck = h.create(kind === 'once' ? { kind: 'once', runAt: '2026-11-16T09:00:00Z' } : undefined);
    h.create();
    const sweep = h.fireDueSchedules();
    let settled = false;
    sweep.then(() => { settled = true; });
    t.mock.timers.tick(600000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true, 'a hung launch must not hold the sweep forever');
    await sweep;
    assert.equal(h.calls, 2);
    assert.equal(h.messages[0].type, 'schedule-error');
    assert.equal(h.messages[0].id, stuck.id);
    assert.match(h.messages[0].message, /timed out/i);
    assert.equal(h.messages[1].type, 'schedule-fired');
    assert.equal(h.reload().due(Date.parse('2026-11-16T09:00:00Z')).length, 0);
    h.advance(86400000);
    await h.fireDueSchedules();
    assert.equal(h.calls, kind === 'cron' ? 4 : 3);
    const beforeLateCompletion = h.store.snapshot();
    const beforeMessages = [...h.messages];
    finish({ sessionId: 'LATE' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.store.snapshot(), beforeLateCompletion);
    assert.deepEqual(h.messages, beforeMessages);
  });
}

test('manual launch timeout preserves its automatic slot and ignores late rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectLaunch;
  const h = harness(t, () => new Promise((_resolve, reject) => { rejectLaunch = reject; }));
  const s = h.create();
  const firing = h.fireSchedule(s.id, { manual: true });
  t.mock.timers.tick(600000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].type, 'schedule-error');
  await firing;
  assert.equal(h.store.snapshot().schedules[0].nextRunAt, s.nextRunAt);
  assert.equal(h.store.snapshot().schedules[0].enabled, true);
  rejectLaunch(new Error('Late launch failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.messages.length, 1);
});

test('a four-minute launch still records success before the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const h = harness(t, () => new Promise((resolve) => { finish = resolve; }));
  const s = h.create();
  const sweep = h.fireDueSchedules();
  t.mock.timers.tick(240000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.messages, []);
  finish({ sessionId: 'SLOW' });
  await sweep;
  assert.equal(h.messages[0].type, 'schedule-fired');
  assert.equal(h.store.snapshot().schedules.find((x) => x.id === s.id).lastSessionId, 'SLOW');
});
