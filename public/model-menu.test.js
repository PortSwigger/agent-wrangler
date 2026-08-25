import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentModelValue } from './model-menu.js';

// The Claude adapter's real labels — the shapes this has to disambiguate.
const MODELS = [
  { value: 'fable', label: 'Fable 5 · 1M context' },
  { value: 'opus', label: 'Opus 5 · 1M context' },
  { value: 'opusplan', label: 'Opus plan · Sonnet execution' },
  { value: 'sonnet', label: 'Sonnet 5 · 200K context' },
  { value: 'sonnet[1m]', label: 'Sonnet 5 · 1M context' },
  { value: 'haiku', label: 'Haiku 4.5 · 200K context' },
];

test('an unambiguous pane label ticks its row', () => {
  assert.equal(currentModelValue(MODELS, 'Opus 5', null), 'opus');
  assert.equal(currentModelValue(MODELS, 'Fable 5', null), 'fable');
  assert.equal(currentModelValue(MODELS, 'Haiku 4.5', null), 'haiku');
});

// "Opus 5" must not also match "Opus plan · Sonnet execution".
test('Opus 5 does not collide with Opus plan', () => {
  assert.equal(currentModelValue(MODELS, 'Opus 5', null), 'opus');
  assert.equal(currentModelValue(MODELS, 'Opus plan', null), 'opusplan');
});

// The status bar says "Sonnet 5" for both 200K and 1M, so nothing may be ticked
// on the strength of the label alone — a wrong tick is worse than none.
test('an ambiguous label with nothing remembered ticks nothing', () => {
  assert.equal(currentModelValue(MODELS, 'Sonnet 5', null), null);
  assert.equal(currentModelValue(MODELS, 'Sonnet 5', undefined), null);
});

test('an ambiguous label is broken by what was last asked for', () => {
  assert.equal(currentModelValue(MODELS, 'Sonnet 5', 'sonnet[1m]'), 'sonnet[1m]');
  assert.equal(currentModelValue(MODELS, 'Sonnet 5', 'sonnet'), 'sonnet');
});

// Self-healing: a switch made in the pane leaves the memory pointing elsewhere,
// and an unambiguous label must ignore it rather than trust it.
test('a stale memory never overrides an unambiguous label', () => {
  assert.equal(currentModelValue(MODELS, 'Opus 5', 'sonnet[1m]'), 'opus');
});

test('a memory that no longer matches the label ticks nothing', () => {
  assert.equal(currentModelValue(MODELS, 'Sonnet 5', 'opus'), null);
});

test('no label means nothing is ticked', () => {
  assert.equal(currentModelValue(MODELS, null, 'opus'), null);
  assert.equal(currentModelValue(MODELS, '', 'opus'), null);
});

test('an unrecognised label ticks nothing', () => {
  assert.equal(currentModelValue(MODELS, 'Gemini 9', null), null);
});
