import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoCompactPresetTokens } from './auto-compact-presets.js';

test('auto-compaction presets are tailored to the selected provider', () => {
  assert.deepEqual(autoCompactPresetTokens('codex'), [50000, 100000, 250000]);
  assert.deepEqual(autoCompactPresetTokens('claude'), [100000, 250000, 500000, 1000000]);
});
