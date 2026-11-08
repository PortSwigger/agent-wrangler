import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringOf, ringOffset, RING_C } from './rail-buttons.js';

test('ringOf: null for none, busy for a spin, a clamped fraction otherwise', () => {
  assert.equal(ringOf(null), null);
  assert.equal(ringOf(undefined), null);
  assert.equal(ringOf(NaN), null);
  assert.equal(ringOf('half'), null);
  assert.equal(ringOf(true), 'busy');
  assert.equal(ringOf('busy'), 'busy');
  assert.equal(ringOf(0.25), 0.25);
  assert.equal(ringOf(-1), 0);
  assert.equal(ringOf(4), 1);
});

test('ringOffset: an empty ring at 0, a full one at 1', () => {
  assert.equal(ringOffset(0), RING_C);
  assert.equal(ringOffset(1), 0);
  assert.ok(Math.abs(ringOffset(0.5) - RING_C / 2) < 1e-9);
});
