import test from 'node:test';
import assert from 'node:assert/strict';
import { paneComposerDraft } from './ghost-suggestion.js';

// Fixtures match the shape of real `capture-pane -e` output, verified against a
// live Claude pane: a rule, the composer (a `❯ `-prefixed line plus indented
// continuations), a rule, then the status line. The rule's own width is what the
// parser uses as the wrap width, so these keep it explicit.
// Written as an explicit escape rather than a literal byte: a raw 0x1b is easy
// to lose when a file is edited, and losing it makes every fixture silently wrong.
const ESC = '\x1b';
const W = 60;

const pane = (composerLines, { width = W } = {}) => [
  `${ESC}[0m⏺ some earlier assistant output`,
  '─'.repeat(width),
  ...composerLines,
  '─'.repeat(width),
  `${ESC}[0m  ✦ Opus 5 (1M) | ░░░ 4% | 📁 proj`,
].join('\n');

// The composer's first line carries the mark; SGR 39 is what a real restored
// prompt renders as (normal colour, NOT faint).
const marked = (text) => `${ESC}[39m❯ ${text}`;
const cont = (text) => `  ${text}`;
const faint = (text) => `${ESC}[2m${text}${ESC}[22m`;

test('a single-line draft is returned as typed', () => {
  assert.equal(paneComposerDraft(pane([marked('what is failing here?')])), 'what is failing here?');
});

test('a wrapped draft is rejoined with single spaces — verified byte-exact against a real 212-char prompt', () => {
  const draft = paneComposerDraft(pane([
    marked('I am running the toolbox and every tool call fails with'),
    cont('the same message about a null key, which I do not'),
    cont('understand yet.'),
  ]));
  assert.equal(draft, 'I am running the toolbox and every tool call fails with the same message about a null key, which I do not understand yet.');
});

test('an empty composer is null, which is the COMMON case', () => {
  // Measured: the restore never happened for a multi-line prompt (5 and 13 lines
  // tested), nor for a 64-character one, and an identical 212-character prompt
  // restored on one run but not on two later ones. So absence is normal and the
  // caller must have a fallback — it is never a signal that nothing was pending.
  assert.equal(paneComposerDraft(pane([marked('')])), null);
  assert.equal(paneComposerDraft(pane([`${ESC}[39m❯ `])), null);
});

test('faint ghost text is not a draft', () => {
  // It occupies the composer visually but a paste replaces it wholesale, so
  // returning it would hand the agent's own suggestion back as the human's prompt.
  assert.equal(paneComposerDraft(pane([marked(faint('try the other approach'))])), null);
});

test('a draft is still read when ghost text trails it', () => {
  assert.equal(
    paneComposerDraft(pane([marked(`real words ${faint('and a suggestion')}`)])),
    'real words',
  );
});

test('a line filling the pane is REFUSED — a hard wrap may have eaten a word boundary', () => {
  // Verified against a live pane: a 130-character path split as `…segment-s` /
  // `gment-…`, so rejoining with a space would silently corrupt it. There is no
  // way to tell that apart from a wrap that fell on a space, so this bails.
  const full = 'x'.repeat(W - 2); // plus the two-char '❯ ' prefix == W
  const draft = paneComposerDraft(pane([marked(full), cont('more text after the break')]));
  assert.equal(draft, null);
});

test('a collapsed paste placeholder is refused, not reported as the prompt', () => {
  assert.equal(paneComposerDraft(pane([marked('[Pasted text #2 +31 lines]')])), null);
});

test('input with no escape sequences is refused — ghost text cannot be told apart without them', () => {
  const plain = pane([marked('some text')]).replaceAll(ESC, '');
  assert.equal(paneComposerDraft(plain), null);
});

test('a capture with no composer rules is refused rather than guessed at', () => {
  assert.equal(paneComposerDraft(`${ESC}[0m❯ text with no rules around it`), null);
  assert.equal(paneComposerDraft(''), null);
  assert.equal(paneComposerDraft(null), null);
  assert.equal(paneComposerDraft(undefined), null);
});

test('a composer block whose first line carries no prompt mark is refused', () => {
  assert.equal(paneComposerDraft(pane([cont('orphan continuation line')])), null);
});

test('an absurdly wide "rule" that is really something else is refused', () => {
  // Guards the width derivation: a 10-char rule would make every line look
  // full-width and is not a real pane.
  assert.equal(paneComposerDraft(pane([marked('text')], { width: 12 })), null);
});

test('an over-long reconstruction is refused', () => {
  // Bounded so a misparse cannot return a screenful of conversation as "the
  // prompt". Over the cap falls back to the transcript, which is exact anyway.
  const long = Array.from({ length: 400 }, (_, i) => cont(`line ${i} of text`));
  const joined = paneComposerDraft(pane([marked('start'), ...long]));
  assert.equal(joined, null);
  // …and just under the cap still comes back, so the bound is a ceiling and not a
  // second, accidental refusal of ordinary long prompts.
  const short = Array.from({ length: 40 }, (_, i) => cont(`line ${i} of text`));
  assert.ok((paneComposerDraft(pane([marked('start'), ...short])) || '').startsWith('start line 0 of text'));
});
