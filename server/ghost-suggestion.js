// Claude Code's suggested next prompt, read off the pane.
//
// This is the ONE piece of the chat view that cannot come from the transcript,
// and the exception is deliberate and narrow. Verified against a live session
// while the suggestion was on screen: it exists only in the TUI's own memory.
// It is absent from the session jsonl, `atis-latch`'s `atis` field is empty in
// every one of 181 occurrences across 150 transcripts, no file under ~/.claude
// is written when it appears, and history.jsonl records only prompts actually
// submitted. It reaches disk after acceptance as an ordinary user message,
// indistinguishable from typing. The rendered pane is its only external
// representation.
//
// So the rule for this module is "hide on any doubt". A missed suggestion costs
// nothing — that is exactly the behaviour before it existed. A WRONG one is
// expensive: the composer line also holds whatever the human is part-way
// through typing, and echoing someone's own half-written draft back at them as
// the agent's suggestion is worse than showing nothing. Every ambiguity below
// therefore returns null.
//
// A LEAF: imports nothing, so it unit-tests from a captured string.

const ESC = '\x1b';

// The composer's prompt marker (U+276F). Everything before it on the line is
// frame; the suggestion, when there is one, follows it.
const PROMPT_MARK = '❯';

// Ghost text is drawn with SGR 2 (faint) and closed by a reset. Matched exactly
// rather than by "any sequence containing a 2" — SGR 2 is what the TUI emits,
// and a looser match would start claiming 256-colour codes (38;5;244 and
// friends) that merely contain the digit.
const DIM_OPEN = `${ESC}[2m`;
const DIM_CLOSE = new RegExp(`${ESC}\\[(?:0|22)?m`);

// Any escape sequence, for deciding whether what is left over is really "no
// visible text".
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

// A suggestion is one line of prompt. Anything longer is not something this
// parser understood correctly.
const MAX_SUGGESTION = 300;

const visible = (s) => s.replace(ANSI, '').trim();

// `paneText` must come from `capture-pane -e` — WITHOUT the escape sequences
// there is no way to tell ghost text from typed text, which is the whole basis
// of this parser. Plain text in means null out, not a guess.
export function parseGhostSuggestion(paneText) {
  if (typeof paneText !== 'string' || !paneText) return null;
  // Only the composer, and only its last occurrence: a `❯` can legitimately
  // appear in scrolled-back conversation text above it.
  const line = paneText.split('\n').filter((l) => l.includes(PROMPT_MARK)).pop();
  if (!line) return null;

  const after = line.slice(line.indexOf(PROMPT_MARK) + PROMPT_MARK.length);
  const open = after.indexOf(DIM_OPEN);
  if (open === -1) return null; // nothing faint on the line — no suggestion

  // Anything visible BEFORE the faint run means the human has typed something.
  // Their draft owns the composer at that point, so there is no suggestion to
  // report even if the TUI is still drawing one after it.
  if (visible(after.slice(0, open))) return null;

  const rest = after.slice(open + DIM_OPEN.length);
  const close = rest.search(DIM_CLOSE);
  // Require the faint run to be closed on this same line. An unterminated run is
  // a suggestion that wrapped, and the continuation is on a line this parser is
  // not reading — reporting the first line alone would load a TRUNCATED prompt
  // into the composer, which is worse than loading none.
  if (close === -1) return null;

  const text = visible(rest.slice(0, close));
  if (!text || text.length > MAX_SUGGESTION) return null;
  // Trailing visible text after the faint run is a shape this parser does not
  // model — bail rather than assume the leading part was the whole suggestion.
  if (visible(rest.slice(close))) return null;
  return text;
}
