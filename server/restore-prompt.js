import fsp from 'node:fs/promises';
import { scanChatText } from './chat-events.js';

// How much of the tail of a transcript to read when looking for the newest user
// message. Generous enough that a turn full of large tool output cannot push the
// prompt out of the window, small enough that this stays a cheap read on a
// transcript that has grown to tens of megabytes.
export const TAIL_BYTES = 512 * 1024;

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
export async function lastUserPrompt(file, agent = 'claude', { readFile = defaultTailRead } = {}) {
  if (!file) return null;
  let text;
  try {
    text = await readFile(file, TAIL_BYTES);
  } catch {
    return null;
  }
  if (!text) return null;
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

async function defaultTailRead(file, bytes) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(size, bytes));
    if (!buf.length) return '';
    await handle.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
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
