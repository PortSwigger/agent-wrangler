import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridRowHeight, computeLayout, tileSpan, localSwapPlacement } from './layout.js';

const awake = () => 'awake';
const sessions = (n) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}` }));
const tiles = (spans) => spans.map((span, i) => ({ id: `t${i}`, span }));
const end = (tile) => tile.rowStart + tile.span;

function assertNoOverlap(layout) {
  const cells = new Set();
  for (const tile of layout.placed) {
    for (let r = tile.rowStart; r < end(tile); r++) {
      const key = `${tile.col}:${r}`;
      assert.ok(!cells.has(key), `overlapping cell ${key}`);
      cells.add(key);
    }
  }
}

test('five fixed sections exactly fill the viewport including padding and gaps', () => {
  for (const height of [400, 600, 880, 1107, 1500]) {
    const row = gridRowHeight(height);
    assert.equal(row * 5 + 4 * 12 + 28, height);
    assert.ok(row > 0);
  }
});

test('row height stays positive before the board has a measurable height', () => {
  assert.ok(gridRowHeight(0) > 0);
});

test('task demand accounts for chrome and inter-section gaps at exact boundaries', () => {
  assert.equal(tileSpan(sessions(1), 122, 0, awake), 1);
  assert.equal(tileSpan(sessions(1), 121, 0, awake), 2);
  assert.equal(tileSpan(sessions(2), 100, 5, awake), 2);
  assert.equal(tileSpan(sessions(2), 100, 6, awake), 3);
});

test('expanded content can request five rows; collapsing reduces the demand', () => {
  const expanded = tileSpan(sessions(1), 150, 24 * 34 + 42, awake);
  const collapsed = tileSpan(sessions(1), 150, 42, awake);
  assert.equal(expanded, 5);
  assert.equal(collapsed, 2);
});

test('compact and full nested sessions count only their rendered height', () => {
  const all = sessions(5);
  const collapsed = tileSpan(all, 150, 0, awake, 0, 4);
  const compact = tileSpan(all, 150, 0, awake, 4, 4);
  const full = tileSpan(all, 150, 0, awake, 0, 4, 0, 0, 0, 4);
  assert.equal(collapsed, 1);
  assert.ok(compact > collapsed);
  assert.ok(full > compact);
});

test('large tasks keep a four-row cap when the board must scroll', () => {
  const layout = computeLayout(tiles([5, 5, 5, 5]), 2);
  assert.ok(layout.scroll);
  assert.ok(layout.placed.every((t) => t.span === 4));
  assertNoOverlap(layout);
});

test('one large task uses a spare fifth row without stretching its short neighbour', () => {
  const layout = computeLayout(tiles([5, 1]), 2);
  assert.equal(layout.placed[0].span, 5);
  assert.equal(layout.placed[1].span, 1);
  assert.equal(layout.rows, 5);
  assert.equal(layout.scroll, false);
});

test('a fifth row cannot push a task below the viewport', () => {
  const layout = computeLayout(tiles([5, 1]), 1);
  assert.deepEqual(layout.placed.map((t) => t.span), [4, 1]);
  assert.equal(layout.rows, 5);
  assert.equal(layout.scroll, false);
});

test('an empty final section is not used to stretch a short task', () => {
  const layout = computeLayout(tiles([2, 1]), 1);
  assert.deepEqual(layout.placed.map((t) => t.span), [2, 1]);
  assert.equal(layout.rows, 3);
});

test('single-column boards retain task spans and scroll after five rows', () => {
  const layout = computeLayout(tiles([3, 3, 1]), 1);
  assert.deepEqual(layout.placed.map((t) => [t.rowStart, t.span]), [[0, 3], [3, 3], [6, 1]]);
  assert.equal(layout.rows, 7);
  assert.equal(layout.scroll, true);
});

test('dense boards pack without overlaps across widths and mixed task sizes', () => {
  for (const cols of [1, 2, 3, 6]) {
    for (let n = 1; n <= 30; n++) {
      const layout = computeLayout(tiles(Array.from({ length: n }, (_, i) => i % 5 + 1)), cols);
      assert.ok(layout.cols <= cols);
      assert.equal(layout.placed.length, n);
      assertNoOverlap(layout);
      assert.equal(layout.scroll, layout.rows > 5);
      assert.ok(layout.placed.every((t) => t.span <= (layout.scroll ? 4 : 5)));
    }
  }
});

test('drag swaps retain fixed spans and only restack affected columns', () => {
  const layout = computeLayout(tiles([5, 1, 1]), 2);
  const swapped = localSwapPlacement(layout.placed, 't0', 't1');
  assert.equal(swapped.placed.find((t) => t.kind === 'placeholder').span, 4);
  assert.equal(swapped.rows, 5);
  assert.equal(swapped.scroll, false);
  assertNoOverlap(swapped);
});

test('five sections reserve space for a wrapped minimised-task tray', () => {
  for (const trayHeight of [35, 70, 105]) {
    assert.equal(gridRowHeight(880, trayHeight) * 5 + 28 + 4 * 12 + trayHeight + 12, 880);
    assert.ok(gridRowHeight(880, trayHeight) < gridRowHeight(880));
  }
});

test('resizing changes content demand without depending on adjacent tasks', () => {
  const shortViewport = tileSpan(sessions(4), gridRowHeight(600), 0, awake);
  const tallViewport = tileSpan(sessions(4), gridRowHeight(1100), 0, awake);
  assert.ok(shortViewport > tallViewport);
  const short = computeLayout(tiles([5, tallViewport]), 2).placed[1];
  assert.equal(short.span, tallViewport);
});

test('snoozed rows and their collapsed divider use less height than full cards', () => {
  const all = sessions(6);
  const phase = (s) => s.sessionId === 's0' ? 'awake' : 'asleep';
  const expanded = tileSpan(all, 100, 0, phase);
  const collapsed = tileSpan(all, 100, 0, phase, 0, 0, 0, 0, 0, 0, true);
  assert.ok(expanded > collapsed);
  assert.ok(tileSpan(all, 100, 0, awake) > expanded);
});

test('workflow and subagent chrome remain part of content height', () => {
  const one = sessions(1);
  const bare = tileSpan(one, 150, 0, awake);
  const workflow = tileSpan(one, 150, 0, awake, 0, 0, 1);
  const subagents = tileSpan(one, 150, 0, awake, 0, 0, 0, 3, 1);
  assert.equal(bare, 1);
  assert.ok(workflow > bare);
  assert.ok(subagents > bare);
});

test('compressed screen chrome fills all five rows with and without a tray', () => {
  const chrome = { gap: 8, paddingY: 20 };
  for (const trayHeight of [null, 35, 70]) {
    const row = gridRowHeight(900, trayHeight, chrome);
    const tray = trayHeight == null ? 0 : trayHeight + chrome.gap;
    assert.equal(row * 5 + chrome.gap * 4 + chrome.paddingY + tray, 900);
  }
});

test('task spans use the rendered compressed-screen gap at the fit boundary', () => {
  assert.equal(tileSpan(sessions(2), 100, 1, awake, 0, 0, 0, 0, 0, 0, false, 8), 2);
  assert.equal(tileSpan(sessions(2), 100, 2, awake, 0, 0, 0, 0, 0, 0, false, 8), 3);
});

test('swapped tasks use a newly available fifth row in the preview', () => {
  const layout = computeLayout(tiles([5, 1, 4]), 2);
  const swapped = localSwapPlacement(layout.placed, 't2', 't0');
  assert.equal(swapped.placed.find((t) => t.id === 't0').span, 5);
  assert.equal(swapped.scroll, false);
  assertNoOverlap(swapped);
});

test('drag placeholders use a newly available fifth row without changing other columns', () => {
  const placed = [
    { id: 't0', span: 4, requestedSpan: 5, col: 0, rowStart: 0 },
    { id: 't1', span: 1, col: 0, rowStart: 4 },
    { id: 't2', span: 4, col: 1, rowStart: 0 },
    { id: 't3', span: 1, col: 2, rowStart: 0 },
  ];
  const before = placed.filter((t) => t.col === 2);
  const swapped = localSwapPlacement(placed, 't0', 't2');
  assert.equal(swapped.placed.find((t) => t.kind === 'placeholder').span, 5);
  assert.deepEqual(swapped.placed.filter((t) => t.col === 2), before);
  assertNoOverlap(swapped);
});

test('scrolling swap previews return spare rows in every column without mutating the canonical layout', () => {
  const layout = computeLayout(tiles([1, 2, 4, 5]), 3);
  const before = structuredClone(layout.placed);
  const swapped = localSwapPlacement(layout.placed, 't0', 't2');
  assert.equal(swapped.scroll, true);
  assert.ok(swapped.placed.every((t) => t.span <= 4));
  assert.deepEqual(layout.placed, before);
  assertNoOverlap(swapped);
});
