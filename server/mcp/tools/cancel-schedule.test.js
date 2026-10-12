import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelScheduleTool } from './cancel-schedule.js';

function deps(schedules) {
  const calls = { delete: [], rebuild: 0 };
  return {
    calls,
    scheduleStore: { schedules, delete: (id) => { calls.delete.push(id); return true; } },
    rebuild: async () => { calls.rebuild += 1; },
  };
}

test('deletes a known schedule and rebuilds', async () => {
  const d = deps([{ id: 'sch_1', name: 'wake me' }]);
  const out = await cancelScheduleTool.handler({ deps: d }, { id: 'sch_1' });
  assert.deepEqual(d.calls.delete, ['sch_1']);
  assert.equal(d.calls.rebuild, 1);
  assert.deepEqual(out.structuredContent, { id: 'sch_1', name: 'wake me', cancelled: true });
});

test('errors on an unknown id without deleting', async () => {
  const d = deps([]);
  const out = await cancelScheduleTool.handler({ deps: d }, { id: 'nope' });
  assert.equal(out.isError, true);
  assert.equal(d.calls.delete.length, 0);
  assert.equal(d.calls.rebuild, 0);
});
