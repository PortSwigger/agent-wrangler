import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduleStore } from '../../schedule-store.js';
import { TOOLS } from './index.js';

const now = Date.parse('2030-01-01T00:00:00Z');
function setup() {
  const scheduleStore = new ScheduleStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'schedule-update-')), 'schedules.json'));
  let rebuilds = 0;
  const deps = { scheduleStore, taskStore: { taskFor: () => null }, rebuild: async () => { rebuilds++; } };
  const original = scheduleStore.create({ name: 'Daily check', when: { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, action: { kind: 'session', sessionId: 'original-card', message: 'Check progress', focus: true } }, now);
  return { deps, original, rebuilds: () => rebuilds };
}
async function update(deps, args) {
  const tool = TOOLS.find(t => t.name === 'update_schedule');
  assert.ok(tool, 'update_schedule is registered');
  return tool.handler({ deps, caller: 'different-card' }, args);
}

test('update_schedule retains id, omitted fields and nextRunAt on name/action edits', async () => {
  const { deps, original, rebuilds } = setup();
  const renamed = await update(deps, { id: original.id, name: 'Renamed check' });
  assert.equal(renamed.isError, undefined);
  assert.equal(renamed.structuredContent.id, original.id);
  assert.deepEqual(JSON.parse(renamed.content[0].text), renamed.structuredContent);
  const edited = await update(deps, { id: original.id, message: 'Updated prompt' });
  assert.equal(edited.isError, undefined);
  const stored = deps.scheduleStore.snapshot().schedules[0];
  assert.deepEqual(stored, { ...original, name: 'Renamed check', action: { ...original.action, message: 'Updated prompt' } });
  assert.equal(rebuilds(), 2);
});

test('update_schedule replaces timing and recomputes nextRunAt', async () => {
  const { deps, original } = setup();
  const result = await update(deps, { id: original.id, at: '2035-02-03T12:00:00Z' });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.nextRunAt, '2035-02-03T12:00:00.000Z');
  assert.deepEqual(result.structuredContent.when, { kind: 'once', runAt: '2035-02-03T12:00:00.000Z' });
  const cron = await update(deps, { id: original.id, cron: '0 10 * * *', tz: 'UTC' });
  assert.equal(cron.isError, undefined);
  assert.ok(Date.parse(cron.structuredContent.nextRunAt) > Date.now());
});

test('update_schedule supports dispatch edits and action switches', async () => {
  const { deps, original } = setup();
  assert.equal((await update(deps, { id: original.id, kind: 'dispatch', intent: 'Review changes', cwd: '/tmp', worktree: true })).isError, undefined);
  const before = deps.scheduleStore.snapshot().schedules[0];
  assert.equal(before.action.dispatch.worktreeAuto, true);
  assert.equal((await update(deps, { id: original.id, intent: 'Review again' })).isError, undefined);
  assert.deepEqual(deps.scheduleStore.snapshot().schedules[0].action.dispatch, { ...before.action.dispatch, intent: 'Review again' });
  assert.equal((await update(deps, { id: original.id, kind: 'session', target_session: 'new-card', message: 'Resume' })).isError, undefined);
  assert.deepEqual(deps.scheduleStore.snapshot().schedules[0].action, { kind: 'session', sessionId: 'new-card', message: 'Resume' });
});

test('update_schedule rejects unknown ids and invalid patches without mutation or rebuild', async () => {
  const { deps, original, rebuilds } = setup();
  for (const patch of [ { id: 'missing', name: 'x' }, { at: 'bad' }, { cron: 'bad' }, { at: '2035-01-01', cron: '* * * * *' }, { kind: 'dispatch' }, { kind: 'dispatch', intent: 'x', agent: 'unknown' }, { kind: 'dispatch', intent: 'x', auto_compact_tokens: 1 }, { target_session: '' }, { tz: 'Invalid/Zone' } ]) {
    const result = await update(deps, { id: original.id, ...patch });
    assert.equal(result.isError, true, JSON.stringify(patch));
    assert.deepEqual(deps.scheduleStore.snapshot().schedules, [original]);
  }
  assert.equal(rebuilds(), 0);
});

test('update_schedule retains omitted dispatch metadata and task defaults across callers', async () => {
  const { deps } = setup();
  deps.taskStore.taskFor = () => ({ id: 'caller-task' });
  const original = deps.scheduleStore.create({ when: { kind: 'cron', cron: '0 9 * * *' }, action: { kind: 'dispatch', dispatch: { intent: 'Original', agent: 'claude', addDirs: ['/tmp/shared'], model: 'opus' } } }, now);
  const result = await update(deps, { id: original.id, intent: 'Edited' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(deps.scheduleStore.snapshot().schedules[1], { ...original, action: { kind: 'dispatch', dispatch: { ...original.action.dispatch, intent: 'Edited' } } });
});

test('update_schedule handles timezone-only edits and preserves disabled state', async () => {
  const { deps, original } = setup();
  deps.scheduleStore.markMissed(original.id);
  const renamed = await update(deps, { id: original.id, name: 'Still disabled' });
  assert.equal(renamed.structuredContent.nextRunAt, null);
  const result = await update(deps, { id: original.id, tz: 'America/New_York' });
  assert.equal(result.isError, undefined);
  const stored = deps.scheduleStore.snapshot().schedules[0];
  assert.equal(stored.enabled, false);
  assert.equal(stored.missed, false);
  assert.deepEqual(stored.when, { ...original.when, tz: 'America/New_York' });
  assert.ok(Date.parse(stored.nextRunAt) > Date.now());
});
