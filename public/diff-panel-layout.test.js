import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPanelSizing, nextDiffPanelState } from './diff-panel-layout.js';

test('a diff opened before any drag uses the board’s rendered CSS width', () => {
  assert.deepEqual(
    diffPanelSizing({ gridInlineWidth: '', gridRenderedWidth: 694, fullscreen: false }),
    { width: '694px', sized: true },
  );
});

test('a diff uses the persisted width produced by a resize drag', () => {
  assert.deepEqual(
    diffPanelSizing({ gridInlineWidth: '634px', gridRenderedWidth: 694, fullscreen: false }),
    { width: '634px', sized: true },
  );
});

test('fullscreen removes a fixed diff width so it can fill the available space', () => {
  assert.deepEqual(
    diffPanelSizing({ gridInlineWidth: '634px', gridRenderedWidth: 694, fullscreen: true }),
    { width: '', sized: false },
  );
});

test('a resize while fullscreen is restored when leaving fullscreen', () => {
  let state = nextDiffPanelState({ storedWidth: '', nextWidth: '694px', fullscreen: false });
  assert.deepEqual(state, { storedWidth: '694px', width: '694px', sized: true });

  state = nextDiffPanelState({ storedWidth: state.storedWidth, fullscreen: true });
  assert.deepEqual(state, { storedWidth: '694px', width: '', sized: false });

  state = nextDiffPanelState({ storedWidth: state.storedWidth, nextWidth: '634px', fullscreen: true });
  assert.deepEqual(state, { storedWidth: '634px', width: '', sized: false });

  state = nextDiffPanelState({ storedWidth: state.storedWidth, fullscreen: false });
  assert.deepEqual(state, { storedWidth: '634px', width: '634px', sized: true });
});
