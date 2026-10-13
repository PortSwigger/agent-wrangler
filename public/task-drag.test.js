import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotTaskRects, taskAtPoint } from './task-drag.js';

const cell = (id, top, height) => ({
  dataset: id === 'adhoc' ? { entity: 'no-task' } : { taskid: id },
  getBoundingClientRect: () => ({ left: 20, right: 320, top, bottom: top + height, height }),
});

test('task drag reaches below-the-fold tasks after scrolling without changing its snapshot', () => {
  const grid = { scrollTop: 0, scrollLeft: 0, querySelectorAll: () => [cell('A', 50, 500), cell('B', 562, 200)] };
  const rects = snapshotTaskRects(grid, 'adhoc');
  assert.equal(taskAtPoint(rects, 40, 100, grid), 'A');
  grid.scrollTop = 500;
  assert.equal(taskAtPoint(rects, 40, 100, grid), 'B');
  assert.equal(taskAtPoint(rects, 40, 56, grid), null);
  assert.equal(rects[1].rect.height, 200);
});

test('task drag snapshots preserve existing scroll offsets and Unassigned identity', () => {
  const grid = { scrollTop: 300, scrollLeft: 10, querySelectorAll: () => [cell('adhoc', 80, 150)] };
  const rects = snapshotTaskRects(grid, 'adhoc');
  assert.equal(taskAtPoint(rects, 30, 100, grid), 'adhoc');
  grid.scrollTop = 350;
  assert.equal(taskAtPoint(rects, 30, 40, grid), 'adhoc');
  grid.scrollLeft = 400;
  assert.equal(taskAtPoint(rects, 30, 40, grid), null);
});
