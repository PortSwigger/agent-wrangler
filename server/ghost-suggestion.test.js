import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parseGhostSuggestion, paneComposerIsEmpty } from './ghost-suggestion.js';

const E = '\x1b';
// Reproduced from a real `capture-pane -e` of a live Claude Code session that was
// showing the suggestion "point 5". The frame lines carry their own 256-colour
// codes, which is why the faint match has to be exact rather than "contains a 2".
const FRAME = `${E}[38;5;244m${'─'.repeat(20)}`;
const composer = (body) => `${E}[39m❯ ${body}`;
const codexPlaceholder = `${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`;
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

// --- paneComposerIsEmpty: the guard before pasting a slash command ---

test('an empty composer is confirmed empty', () => {
  assert.equal(parseGhostSuggestion(composer('')), null);
  assert.equal(paneComposerIsEmpty([FRAME, composer(''), FRAME].join('\n')), true);
});

test('a composer holding only ghost text is still empty', () => {
  // Nothing was typed; a paste would replace the suggestion, not collide with it.
  assert.equal(paneComposerIsEmpty(composer(`${E}[2mpoint 5${E}[0m`)), true);
});

test('typed text means not empty', () => {
  assert.equal(paneComposerIsEmpty(composer('half a prompt')), false);
  assert.equal(paneComposerIsEmpty(composer(`typed${E}[2mpoint 5${E}[0m`)), false);
});

test('the styled Codex placeholder confirms an empty Codex composer', () => {
  assert.equal(paneComposerIsEmpty(codexPlaceholder, 'codex'), true);
});

test('a placeholder-looking output line never masks a Codex draft', () => {
  const echoedPlaceholder = `${E}[39m› Ask Codex to do anything${E}[0m`;
  const draft = `${E}[1m›${E}[0m explain this failure`;
  assert.equal(paneComposerIsEmpty([echoedPlaceholder, draft].join('\n'), 'codex'), false);
});

test('a placeholder without Codex composer styling is not trusted', () => {
  assert.equal(paneComposerIsEmpty(`${E}[39m› Ask Codex to do anything${E}[0m`, 'codex'), false);
});

test('a stray Claude prompt mark never masks a Codex draft', () => {
  const strayClaudeMark = `${E}[0m    ${E}[2m───── ❯ ${E}[0m`;
  const draft = `${E}[1m›${E}[0m explain this failure`;
  assert.equal(paneComposerIsEmpty([strayClaudeMark, draft].join('\n'), 'codex'), false);
});

test('a working Codex pane is not safe to notify yet', () => {
  const working = `${E}[1m•${E}[0m Working ${E}[2m(12s · esc to interrupt)${E}[0m`;
  assert.equal(paneComposerIsEmpty([working, codexPlaceholder].join('\n'), 'codex'), false);
});

test('a long-running Codex status with background-terminal text is not an empty composer', () => {
  const working = `${E}[1m•${E}[0m Working ${E}[2m(27m 09s • esc to interrupt)${E}[0m · 1 background terminal running · /ps to…`;
  assert.equal(paneComposerIsEmpty([working, codexPlaceholder].join('\n'), 'codex'), false);
});

test('quoted working text in Codex pane history does not block an empty composer', () => {
  const quoted = `${E}[39mgrep result: esc to interrupt\n${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`;
  assert.equal(paneComposerIsEmpty(quoted, 'codex'), true);
});

// A live idle Codex pane whose mail sat undelivered. tmux's `capture-pane -e`
// writes each SGR as a diff from the previous cell, across line breaks: the dim
// "Worked for" line leaves dim on, so the bold prompt mark arrives as `0;1m`.
const codexIdleAfterDim = fs.readFileSync(
  new URL('./fixtures/codex-idle-pane-reset-bold-prompt.txt', import.meta.url), 'utf8',
);

test('an idle Codex pane whose prompt mark arrives as reset+bold is an empty composer', () => {
  assert.equal(paneComposerIsEmpty(codexIdleAfterDim, 'codex'), true);
});

test('the Codex prompt mark is judged by its rendered style, not the SGR bytes before it', () => {
  assert.equal(paneComposerIsEmpty(`${E}[22;1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`, 'codex'), true);
  assert.equal(paneComposerIsEmpty(`${E}[1;38;2;1;2;3m›${E}[0m ${E}[0;2mAsk Codex to do anything${E}[0m`, 'codex'), true);
  const inheritedBold = `${E}[1mbold tail\n›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`;
  assert.equal(paneComposerIsEmpty(inheritedBold, 'codex'), true);
});

test('a reset+bold Codex prompt holding typed text is not empty', () => {
  const pane = codexIdleAfterDim.replace(`${E}[2mAsk Codex to do anything${E}[0m`, 'explain this failure');
  assert.notEqual(pane, codexIdleAfterDim);
  assert.equal(paneComposerIsEmpty(pane, 'codex'), false);
});

test('the placeholder text typed for real is not an empty Codex composer', () => {
  assert.equal(paneComposerIsEmpty(`${E}[0;1m›${E}[0m Ask Codex to do anything`, 'codex'), false);
  assert.equal(paneComposerIsEmpty(`${E}[0;1m›${E}[0m ${E}[2mAsk Codex${E}[0m to do anything`, 'codex'), false);
  assert.equal(paneComposerIsEmpty(`${E}[0;1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m!`, 'codex'), false);
});

test('a dim echoed prompt in Codex history is never taken for the composer', () => {
  const echoed = `${E}[1;2m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`;
  assert.equal(paneComposerIsEmpty(echoed, 'codex'), false);
  const inheritedDim = `${E}[2mdim tail\n${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`;
  assert.equal(paneComposerIsEmpty(inheritedDim, 'codex'), false);
});

test('a placeholder above a real Codex draft never masks it', () => {
  const pane = [codexPlaceholder, `${E}[0;1m›${E}[0m explain this failure`].join('\n');
  assert.equal(paneComposerIsEmpty(pane, 'codex'), false);
});

test('non-SGR escapes around the Codex composer are not read as typed text', () => {
  const placeholder = `${E}[2mAsk Codex to do anything${E}[0m`;
  assert.equal(paneComposerIsEmpty(`${E}]8;;https://x${E}\\${E}[1m›${E}[0m ${placeholder}${E}]8;;\x07`, 'codex'), true);
  assert.equal(paneComposerIsEmpty(`${E}(B${E}[1m›${E}[0m ${placeholder}`, 'codex'), true);
  assert.equal(paneComposerIsEmpty(`${E}[1m›${E}[0m ${E}]8;;u\x07typed${E}]8;;\x07`, 'codex'), false);
  assert.equal(paneComposerIsEmpty(`${E}[1m›${E}[0m ${E}]8;;unterminated ${placeholder}`, 'codex'), false);
});

test('a reset+bold empty Codex composer under a working status is not safe', () => {
  const working = `${E}[1m•${E}[0m Working ${E}[2m(12s · esc to interrupt)${E}[0m`;
  assert.equal(paneComposerIsEmpty([working, codexIdleAfterDim].join('\n'), 'codex'), false);
});

// Fail-safe: anything unreadable must answer "not empty" so no paste happens.
test('an unreadable capture is never reported as empty', () => {
  assert.equal(paneComposerIsEmpty('❯ '), false, 'no escapes: cannot judge');
  assert.equal(paneComposerIsEmpty(''), false);
  assert.equal(paneComposerIsEmpty(null), false);
  assert.equal(paneComposerIsEmpty(`${E}[39msome output with no composer`), false);
});
