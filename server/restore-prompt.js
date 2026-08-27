import fsp from 'node:fs/promises';
import { scanChatText } from './chat-events.js';

// The read widens by RESULT, not by a flat byte tail, and that is load-bearing.
// Transcript bytes are mostly tool output rather than turns, so a fixed window is
// no guarantee of containing a single prompt — the same reason chat.js sizes its
// initial window by event count. It also matters for pruning: scanChatText applies
// selectLive, which needs its range read contiguously from a line boundary, and a
// too-small window can prune away every prompt it holds. Measured over 19 real
// transcripts larger than the first attempt, a flat tail returned NULL on one where
// reading further back returned the prompt correctly.
export const FIRST_ATTEMPT_BYTES = 256 * 1024;
// The ceiling matches chat.js's MAX_INITIAL_BYTES: past this, reading more costs
// more than the restore is worth, and the fallback is simply no restore.
export const MAX_READ_BYTES = 8 * 1024 * 1024;

// Claude Code writes its own interruption notice as a `user` message with no
// isMeta flag, so nothing upstream filters it out. Anchored and narrow: only the
// two forms that actually occur, so a human prompt that happens to quote one is
// not swallowed by a loose match.
const INTERRUPT_MARKER = /^\[Request interrupted by user(?: for tool use)?\]$/;

// The newest thing the human said, read FRESH from the transcript, or null.
//
// Read at the moment it is asked for rather than taken from the chat view's last
// poll, and that is the entire point of this function. `lastUserText` in the
// client is only updated when a 2s poll happens to deliver a `user` event, so
// pressing Esc before the newest prompt has been read back left it holding the
// PREVIOUS prompt — the reported "Esc restored the wrong prompt" bug. Reading here
// removes the race rather than narrowing it.
//
// Only the tail is read, so the first line is usually a fragment; scanChatText
// already tolerates an unparseable line, which is what makes that safe.
export async function lastUserPrompt(file, agent = 'claude', { readTail = defaultTailRead } = {}) {
  if (!file) return null;
  for (let bytes = FIRST_ATTEMPT_BYTES; ; bytes *= 2) {
    let chunk;
    try {
      chunk = await readTail(file, bytes);
    } catch {
      return null;
    }
    if (!chunk) return null;
    // An empty or prompt-less window is a reason to WIDEN, not to give up — the
    // bytes in view may be nothing but one large tool result. Only the checks below
    // (start of file reached, or the ceiling hit) end the search.
    const found = chunk.text ? newestPromptIn(chunk, agent) : null;
    // Widen only while there is more file to read and headroom to read it in.
    if (found || chunk.atStart || bytes >= MAX_READ_BYTES) return found;
  }
}

function newestPromptIn(chunk, agent) {
  // A window that does not start at byte 0 begins mid-line. Dropping that fragment
  // is not cosmetic: lineUuids reads the parent/child pair straight off the raw
  // line, so a truncated one contributes a bogus link to the tree selectLive prunes
  // against.
  const text = chunk.atStart ? chunk.text : chunk.text.slice(chunk.text.indexOf('\n') + 1);
  if (!text.trim()) return null;
  const { events } = scanChatText(text, agent);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.kind !== 'user' || typeof e.text !== 'string') continue;
    const candidate = e.text.trim();
    // Empty happens on a user turn that carried only an image; restoring "" would
    // just blank the composer.
    if (!candidate) continue;
    // …and Claude Code records the interruption ITSELF as a user message, which is
    // exactly what the newest user entry is right after an interrupt — the very
    // moment this function is called. Caught end-to-end against a live pane: the
    // first run of this returned `[Request interrupted by user]` (29 characters)
    // instead of the 212-character prompt. Both observed variants are filtered;
    // counted across 150 real transcripts, they are the only two.
    if (INTERRUPT_MARKER.test(candidate)) continue;
    return e.text;
  }
  return null;
}

// Returns { text, atStart } — `atStart` is what tells the caller there is no more
// file above this window, so it can stop widening and skip the partial-line trim.
async function defaultTailRead(file, bytes) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const len = Math.min(size, bytes);
    if (!len) return { text: '', atStart: true };
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, start);
    return { text: buf.toString('utf8'), atStart: start === 0 };
  } finally {
    await handle.close();
  }
}

// Decide what the chat view should put in its composer after an interrupt.
//
// Two sources, and which one wins is the whole design:
//
//  - The PANE, when it holds a draft. Interrupting sometimes makes Claude Code
//    restore the interrupted prompt into its own composer, and that text is the
//    most current statement of what is pending — it is the only source that can
//    reflect an edit made in the terminal. So it wins when it is readable.
//  - The TRANSCRIPT otherwise. Measured against a live pane, the restore is
//    unreliable: never for a multi-line prompt (tested at 5 and 13 lines), and for
//    an identical 212-character single-line prompt it happened on one run and not
//    on two later ones. So the pane is absent far more often than not, and treating
//    its absence as "nothing to restore" would break the feature for most prompts.
//
// paneComposerDraft is also deliberately null on anything it cannot reconstruct
// exactly (a token wider than the pane is hard-broken mid-word), so a doubtful
// pane read lands here as a fallback rather than as a corrupted prompt.
export function chooseRestore({ paneDraft, transcriptPrompt }) {
  if (typeof paneDraft === 'string' && paneDraft.trim()) return { text: paneDraft, source: 'pane' };
  if (typeof transcriptPrompt === 'string' && transcriptPrompt.trim()) return { text: transcriptPrompt, source: 'transcript' };
  return { text: null, source: 'none' };
}
