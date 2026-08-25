import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_FONT_SIZES, DEFAULT_CHAT_FONT_SIZE, normalizeChatFontSize } from './chat-font.js';
import { TERM_FONT_SIZES, DEFAULT_TERM_FONT_SIZE } from './term-font.js';

test('default is a member of the preset set', () => {
  assert.ok(CHAT_FONT_SIZES.includes(DEFAULT_CHAT_FONT_SIZE));
});
test('a stored preset value passes through', () => {
  assert.equal(normalizeChatFontSize('16'), 16);
  assert.equal(normalizeChatFontSize(12), 12);
});
test('a non-preset number falls back to the default', () => {
  assert.equal(normalizeChatFontSize(15), DEFAULT_CHAT_FONT_SIZE, '15 is a terminal preset, not a chat one');
  assert.equal(normalizeChatFontSize(24), DEFAULT_CHAT_FONT_SIZE);
  assert.equal(normalizeChatFontSize('13.5'), DEFAULT_CHAT_FONT_SIZE);
});
test('null/undefined/garbage falls back to the default', () => {
  assert.equal(normalizeChatFontSize(null), DEFAULT_CHAT_FONT_SIZE);
  assert.equal(normalizeChatFontSize(undefined), DEFAULT_CHAT_FONT_SIZE);
  assert.equal(normalizeChatFontSize('abc'), DEFAULT_CHAT_FONT_SIZE);
  assert.equal(normalizeChatFontSize(''), DEFAULT_CHAT_FONT_SIZE);
});
// The whole point of the setting is that it is separate from the terminal's, so
// the two must not silently converge on one preset list and default.
test('the chat presets are independent of the terminal presets', () => {
  assert.notDeepEqual(CHAT_FONT_SIZES, TERM_FONT_SIZES);
  assert.notEqual(DEFAULT_CHAT_FONT_SIZE, DEFAULT_TERM_FONT_SIZE);
});
