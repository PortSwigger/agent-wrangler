import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGhostSuggestion } from './ghost-suggestion.js';

const E = '\x1b';
// Reproduced from a real `capture-pane -e` of a live Claude Code session that was
// showing the suggestion "point 5". The frame lines carry their own 256-colour
// codes, which is why the faint match has to be exact rather than "contains a 2".
const FRAME = `${E}[38;5;244m${'─'.repeat(20)}`;
const composer = (body) => `${E}[39m❯ ${body}`;
const realCapture = [
  `${E}[38;5;246m✻${E}[39m ${E}[38;5;246mBrewed for 13s${E}[39m`,
  '',
  FRAME,
  composer(`${E}[2mpoint 5${E}[0m`),
  FRAME,
  `${E}[39m  ${E}[1m${E}[38;5;183m✦ Opus 5${E}[0m`,
].join('\n');

test('reads the suggestion out of a real capture', () => {
  assert.equal(parseGhostSuggestion(realCapture), 'point 5');
});

test('the frame\'s 256-colour codes are not mistaken for faint text', () => {
  // 38;5;244 contains a "2"; a loose match would return the box-drawing run.
  assert.equal(parseGhostSuggestion([FRAME, composer(''), FRAME].join('\n')), null);
});

test('an empty composer with no faint run yields nothing', () => {
  assert.equal(parseGhostSuggestion(composer('')), null);
});

// The expensive failure: the human's own draft must never come back as a suggestion.
test('typed text in the composer suppresses the suggestion', () => {
  assert.equal(parseGhostSuggestion(composer(`Go with option B${E}[2mpoint 5${E}[0m`)), null);
  assert.equal(parseGhostSuggestion(composer('Go with option B')), null);
});

test('an unterminated faint run is a wrapped suggestion, so it is dropped', () => {
  // Reporting the first line alone would load a truncated prompt.
  assert.equal(parseGhostSuggestion(composer(`${E}[2mexplain the whole of book nine in`)), null);
});

test('SGR 22 closes the run as well as SGR 0', () => {
  assert.equal(parseGhostSuggestion(composer(`${E}[2mpoint 5${E}[22m`)), 'point 5');
});

test('visible text after the faint run is an unmodelled shape, so it is dropped', () => {
  assert.equal(parseGhostSuggestion(composer(`${E}[2mpoint 5${E}[0m and more`)), null);
});

test('the LAST prompt mark wins — conversation text above can contain one', () => {
  const pane = [
    `${E}[39msomeone quoted ❯ in an answer${E}[0m`,
    FRAME,
    composer(`${E}[2mpoint 5${E}[0m`),
  ].join('\n');
  assert.equal(parseGhostSuggestion(pane), 'point 5');
});

test('a pane with no composer at all yields nothing', () => {
  assert.equal(parseGhostSuggestion('just some output\nand more'), null);
});

// Plain text cannot be judged: without the escapes there is no faint attribute
// to read, so a caller that forgot `-e` gets null rather than a guess.
test('escape-stripped input yields nothing, never a guess', () => {
  assert.equal(parseGhostSuggestion('❯ point 5'), null);
});

test('an over-long run is not a prompt this parser understood', () => {
  assert.equal(parseGhostSuggestion(composer(`${E}[2m${'x'.repeat(301)}${E}[0m`)), null);
  assert.equal(parseGhostSuggestion(composer(`${E}[2m${'x'.repeat(300)}${E}[0m`)), 'x'.repeat(300));
});

test('a faint run of only whitespace is not a suggestion', () => {
  assert.equal(parseGhostSuggestion(composer(`${E}[2m   ${E}[0m`)), null);
});

test('non-string input yields nothing', () => {
  assert.equal(parseGhostSuggestion(null), null);
  assert.equal(parseGhostSuggestion(undefined), null);
  assert.equal(parseGhostSuggestion(''), null);
});
