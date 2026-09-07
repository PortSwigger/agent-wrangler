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

// A draft is a whole prompt rather than one suggested line, so it gets its own,
// larger bound — but still bounded, because an unbounded read here would happily
// return a screenful of misparsed conversation.
const MAX_COMPOSER_DRAFT = 4000;

const visible = (s) => s.replace(ANSI, '').trim();

// Whether the pane's composer is CONFIRMED empty — nothing typed and no
// suggestion accepted into it. Its own function rather than a negation of
// parseGhostSuggestion, because the two ask different questions: that one wants
// the faint text, this one wants to know whether anything at all is in the way.
//
// Fail-safe by construction: it answers false whenever emptiness cannot be
// confirmed (no escapes, no composer line found, an unreadable capture). The
// caller uses it to decide whether pasting a slash command is safe, and pasting
// into a pane whose state we could not read is exactly what must not happen —
// the paste lands at the cursor, so a draft already there would turn
// "/model sonnet" into a mangled prompt the Enter then submits.
export function paneComposerIsEmpty(paneText) {
  if (typeof paneText !== 'string' || !paneText.includes(ESC)) return false;
  const line = paneText.split('\n').filter((l) => l.includes(PROMPT_MARK)).pop();
  if (!line) return false;
  const after = line.slice(line.indexOf(PROMPT_MARK) + PROMPT_MARK.length);
  // Drop faint runs before judging: ghost text occupies the composer visually
  // but is not content — pressing Enter on it does submit it, but it is not
  // something the human typed, and it is replaced wholesale by a paste.
  const withoutGhost = after.split(DIM_OPEN).map((part, i) => {
    if (i === 0) return part;
    const close = part.search(DIM_CLOSE);
    return close === -1 ? '' : part.slice(close);
  }).join('');
  return !visible(withoutGhost);
}

// The composer's own draft text, reconstructed from the rendered pane, or null.
//
// Why this exists: interrupting a turn sometimes makes Claude Code restore the
// interrupted prompt into its OWN composer, and that restored text is the most
// current statement of what is pending — more current than the transcript, which
// cannot show an edit made in the pane. So when it IS there, it wins.
//
// "Sometimes" is measured, not hedging. Against a live pane on one version, with
// the composer wiped first each time: a 64-character prompt was never restored, a
// 212-character single-line one was restored on one run and NOT on two later runs
// of the identical prompt, and NO multi-line prompt was ever restored (tested at
// 5 and 13 lines). So a caller must treat the absence of a draft as normal and
// have somewhere else to go — never as a signal that nothing was pending.
//
// Governing rule is the same as parseGhostSuggestion's: on any doubt, return null
// and let the caller fall back. A missing draft costs a fallback; a MIS-READ one
// silently rewrites the human's prompt.
//
// The reconstruction: the composer renders as a `❯ `-prefixed first line plus
// indented continuation lines, and the terminal has already re-wrapped it, so the
// original line structure is gone. Rejoining with a single space is exact when the
// wrap fell on a space — verified byte-for-byte against a 212-character prompt —
// but a token wider than the pane is HARD-broken mid-word, and rejoining that
// inserts a space inside it. Verified: a 130-character path split as
// `…segment-s` / `gment-…`. There is no way to tell the two cases apart after the
// fact, so any line that reaches the full pane width means the reconstruction is
// unsafe and this returns null.
export function paneComposerDraft(paneText) {
  if (typeof paneText !== 'string' || !paneText.includes(ESC)) return null;
  const lines = paneText.split('\n');
  // The composer sits between the last two horizontal rules. Locating it by the
  // rules rather than by the prompt mark alone is what lets continuation lines be
  // collected: they carry no mark of their own, so the mark cannot delimit them.
  const isRule = (l) => visible(l).startsWith('─'.repeat(10));
  const rules = lines.map((l, i) => (isRule(l) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return null;
  const top = rules[rules.length - 2];
  const bottom = rules[rules.length - 1];
  // The rule spans the pane, so its own width IS the wrap width — no extra tmux
  // call needed to discover it.
  const width = visible(lines[top]).length;
  if (!Number.isFinite(width) || width < 20) return null;

  const body = lines.slice(top + 1, bottom);
  if (!body.length) return null;
  const first = body[0];
  if (!first.includes(PROMPT_MARK)) return null;

  const parts = [];
  for (let i = 0; i < body.length; i += 1) {
    const raw = i === 0 ? body[i].slice(body[i].indexOf(PROMPT_MARK) + PROMPT_MARK.length) : body[i];
    // Faint runs are dropped: ghost text occupies the composer visually but is not
    // a draft, and a paste replaces it wholesale. Mixing it in would hand back the
    // agent's own suggestion as if the human had written it.
    const withoutGhost = raw.split(DIM_OPEN).map((part, n) => {
      if (n === 0) return part;
      const close = part.search(DIM_CLOSE);
      return close === -1 ? '' : part.slice(close);
    }).join('');
    const plain = withoutGhost.replace(ANSI, '');
    // Measured BEFORE trimming, and on the rendered line as a whole: a line that
    // fills the pane is where a hard break may have eaten a word boundary.
    const rendered = (i === 0 ? PROMPT_MARK + plain : plain).replace(/\s+$/, '');
    if (rendered.length >= width) return null;
    const text = plain.trim();
    if (text) parts.push(text);
  }
  if (!parts.length) return null;
  const text = parts.join(' ');
  // A collapsed paste is a placeholder, not the text — reporting it would put
  // "[Pasted text #2 +31 lines]" in the composer as if it were the prompt.
  if (/^\[Pasted text #\d+/.test(text)) return null;
  if (text.length > MAX_COMPOSER_DRAFT) return null;
  return text;
}

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
