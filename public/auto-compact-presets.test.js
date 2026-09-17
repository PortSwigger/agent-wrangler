import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoCompactPresetTokens, normalizeAutoCompactPreset } from './auto-compact-presets.js';

test('auto-compaction presets are tailored to the selected provider', () => {
  assert.deepEqual(autoCompactPresetTokens('codex'), [50000, 100000, 250000]);
  assert.deepEqual(autoCompactPresetTokens('claude'), [100000, 250000, 500000, 1000000]);
});

test('changing provider clears a threshold not offered by its presets', () => {
  assert.equal(normalizeAutoCompactPreset(50000, 'claude'), undefined);
  assert.equal(normalizeAutoCompactPreset(500000, 'codex'), undefined);
  assert.equal(normalizeAutoCompactPreset(250000, 'codex'), 250000);
  assert.equal(normalizeAutoCompactPreset(undefined, 'claude'), undefined);
});
