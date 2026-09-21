import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPastedContentWrapper } from './pasted-content.js';

test('a single wrapper is stripped, keeping the body verbatim', () => {
  const got = stripPastedContentWrapper('before\n<pasted_content id="e7ce">\nhello world\n</pasted_content id="e7ce">\nafter');
  assert.equal(got, 'before\n\nhello world\n\nafter');
});

test('two distinct wrappers in one message are each unwrapped by their own id', () => {
  const got = stripPastedContentWrapper('<pasted_content id="aaaa">first</pasted_content id="aaaa"> and <pasted_content id="bbbb">second</pasted_content id="bbbb">');
  assert.equal(got, 'first and second');
});

test('a body that itself begins with a harness marker is preserved — the wrapper is proof it is a real paste', () => {
  const got = stripPastedContentWrapper('<pasted_content id="x"><environment_context>literal text I want reviewed</environment_context></pasted_content id="x">');
  assert.equal(got, '<environment_context>literal text I want reviewed</environment_context>');
});

test('an unterminated wrapper is left exactly as written, not eaten by backtracking into later text', () => {
  const input = 'Please look at: <pasted_content id="broke">this never closes';
  assert.equal(stripPastedContentWrapper(input), input);
});

test('a malformed open tag (no closing quote) is left untouched', () => {
  const input = '<pasted_content id="unterminated then plain text with no quote at all';
  assert.equal(stripPastedContentWrapper(input), input);
});

test('an empty id is accepted, matching an empty attribute value', () => {
  const got = stripPastedContentWrapper('<pasted_content id="">body</pasted_content id="">');
  assert.equal(got, 'body');
});

test('a different-id wrapper nested inside another is stripped too (recursion, not one regex pass)', () => {
  const got = stripPastedContentWrapper('<pasted_content id="outer">before <pasted_content id="inner">nested</pasted_content id="inner"> after</pasted_content id="outer">');
  assert.equal(got, 'before nested after');
});

test('text with no wrapper at all passes through unchanged', () => {
  assert.equal(stripPastedContentWrapper('just an ordinary message'), 'just an ordinary message');
});

test('a large run of unterminated openers resolves in roughly linear time, not quadratic', () => {
  const n = 20000;
  const input = '<pasted_content id="x">'.repeat(n);
  const start = Date.now();
  const got = stripPastedContentWrapper(input);
  const elapsed = Date.now() - start;
  assert.equal(got, input); // none close, so nothing is stripped
  // A quadratic implementation over ~480KB of this shape takes hundreds of ms
  // (measured ~340ms at 290KB for the regex this replaced); a linear one
  // finishes in low single-digit ms. 200ms leaves generous headroom for a slow
  // CI runner while still failing loudly on a regression back to O(n^2).
  assert.ok(elapsed < 200, `expected a fast linear scan, took ${elapsed}ms`);
});
