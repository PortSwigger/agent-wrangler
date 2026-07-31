import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TERM_FONT_SIZES, DEFAULT_TERM_FONT_SIZE, normalizeFontSize } from './term-font.js';

test('default is a member of the preset set', () => {
  assert.ok(TERM_FONT_SIZES.includes(DEFAULT_TERM_FONT_SIZE));
});
test('default is 12 — unchanged from the old hardcoded size', () => {
  assert.equal(DEFAULT_TERM_FONT_SIZE, 12);
});
test('a stored preset value passes through', () => {
  assert.equal(normalizeFontSize('14'), 14);
  assert.equal(normalizeFontSize(11), 11);
});
test('a non-preset number falls back to the default', () => {
  assert.equal(normalizeFontSize(20), DEFAULT_TERM_FONT_SIZE);
  assert.equal(normalizeFontSize('13.5'), DEFAULT_TERM_FONT_SIZE);
});
test('null/undefined/garbage falls back to the default', () => {
  assert.equal(normalizeFontSize(null), DEFAULT_TERM_FONT_SIZE);
  assert.equal(normalizeFontSize(undefined), DEFAULT_TERM_FONT_SIZE);
  assert.equal(normalizeFontSize('abc'), DEFAULT_TERM_FONT_SIZE);
  assert.equal(normalizeFontSize(''), DEFAULT_TERM_FONT_SIZE);
});
