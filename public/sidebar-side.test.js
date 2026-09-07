import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SIDEBAR_W, MIN_BOARD_W, sidebarWidthFromDrag } from './sidebar-side.js';

// A 1200px viewport with the sidebar taking the right 500px (the nav rail and
// the board fill the rest). Dragging the handle left widens it, right narrows it.
const right = { left: 700, right: 1200 };
// The mirror image: the same 500px pane on the left, board to its right.
const left = { left: 60, right: 560 };

test('dragging measures from the pane\'s far edge, whichever side it is on', () => {
  assert.equal(sidebarWidthFromDrag({ clientX: 800, rect: right, viewportWidth: 1200, onLeft: false }), 400);
  assert.equal(sidebarWidthFromDrag({ clientX: 460, rect: left, viewportWidth: 1200, onLeft: true }), 400);
});

test('a drag that does not move the handle returns the current width', () => {
  assert.equal(sidebarWidthFromDrag({ clientX: 700, rect: right, viewportWidth: 1200, onLeft: false }), 500);
  assert.equal(sidebarWidthFromDrag({ clientX: 560, rect: left, viewportWidth: 1200, onLeft: true }), 500);
});

test('the pane cannot be dragged narrower than MIN_SIDEBAR_W, on either side', () => {
  assert.equal(sidebarWidthFromDrag({ clientX: 1190, rect: right, viewportWidth: 1200, onLeft: false }), MIN_SIDEBAR_W);
  assert.equal(sidebarWidthFromDrag({ clientX: 70, rect: left, viewportWidth: 1200, onLeft: true }), MIN_SIDEBAR_W);
});

test('the pane cannot be dragged wider than the viewport less MIN_BOARD_W, on either side', () => {
  const cap = 1200 - MIN_BOARD_W;
  assert.equal(sidebarWidthFromDrag({ clientX: 10, rect: right, viewportWidth: 1200, onLeft: false }), cap);
  assert.equal(sidebarWidthFromDrag({ clientX: 1190, rect: left, viewportWidth: 1200, onLeft: true }), cap);
});

// A pane already at the floor still has a rect, and dragging it further the wrong
// way must not produce a negative width the caller would write straight to style.
test('a drag past the far edge clamps rather than going negative', () => {
  assert.equal(sidebarWidthFromDrag({ clientX: 1400, rect: right, viewportWidth: 1200, onLeft: false }), MIN_SIDEBAR_W);
  assert.equal(sidebarWidthFromDrag({ clientX: -200, rect: left, viewportWidth: 1200, onLeft: true }), MIN_SIDEBAR_W);
});

// The floor beats the ceiling when they cross, so a very narrow window still
// yields a usable (if overflowing) pane rather than something below the minimum.
test('on a viewport too narrow for both minimums the floor wins', () => {
  assert.equal(sidebarWidthFromDrag({ clientX: 300, rect: { left: 0, right: 400 }, viewportWidth: 400, onLeft: false }), MIN_SIDEBAR_W);
});
