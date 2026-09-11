import { sendText as defaultSendText, capturePaneStyled as defaultCapture } from './tmux-scraper.js';
import { paneComposerIsEmpty } from './ghost-suggestion.js';

// Hold an AUTOMATED pane notification back while the human is mid-prompt.
//
// Every paste lands at the composer's cursor, so a PR nudge arriving while
// someone is half-way through typing splices itself into their draft — and the
// Enter that follows submits the fused text as one prompt. `/model` already
// refuses to paste for exactly this reason (set-session-model.js); this is the
// same guard applied to the notifications the SERVER decides to send: the PR
// lines in index.js, deliverPrNudge, and the mailbox announcement. A message a
// human deliberately sends from the board composer (deliverMessage) is NOT
// routed through here — they chose to send it, and it carries its own
// clearComposer semantics for the interrupt-restore case.
//
// Fail-safe direction is the whole design: `paneComposerIsEmpty` confirms
// emptiness and answers false for an unreadable capture, a missing composer
// line or a pane it could not parse, so ANY doubt defers. A deferred
// notification costs a delay; a pasted one corrupts a prompt the human is
// about to send.
//
// Deferral is unbounded in TIME on purpose — a transition never re-fires (the
// notifier's diff baselines consume it), so an expiry would silently drop the
// one signal auto-fix-checks runs on. It is bounded in SIZE only, as a memory
// backstop. The queue is in-memory: a restart drops it, which is the accepted
// trade for not adding a JSON store for text whose board toast already fired.
export const MAX_PENDING_PER_CARD = 200;

// How many lines of pane to read when judging the composer. Matches
// clearComposer's own capture depth — enough for a wrapped prompt's last line.
const CAPTURE_LINES = 6;

export function createPaneDeferral({
  tmuxFor, socketFor,
  sendText = defaultSendText,
  capture = defaultCapture,
} = {}) {
  // card id -> lines awaiting a clear composer, oldest first.
  const pending = new Map();
  // Card ids a drain is currently committing. Two overlapping drains would
  // otherwise both read the same queue and paste it twice.
  const inFlight = new Set();

  function enqueue(id, text) {
    const q = pending.get(id) || [];
    // A repeat of the line already at the tail says nothing new — the same
    // poll-driven transition can be re-detected while the queue waits.
    if (q.at(-1) !== text) q.push(text);
    while (q.length > MAX_PENDING_PER_CARD) q.shift();
    pending.set(id, q);
  }

  async function composerIsClear(tmux, socket) {
    try {
      return paneComposerIsEmpty(await capture(tmux, CAPTURE_LINES, socket));
    } catch {
      return false;
    }
  }

  // Paste `text` into the card's pane if its composer is confirmed empty,
  // otherwise queue it for the next drain. `tmux`/`socket` override the lookup
  // for a pane the caller already holds (deliverPrNudge's post-resume handle,
  // which tmuxFor may not report yet). Returns 'sent' | 'deferred'.
  async function deliverOrDefer({ id, text, tmux, socket }) {
    const name = tmux ?? tmuxFor?.(id) ?? null;
    // No pane means no draft to protect and nothing to paste into: queue it and
    // let the drain deliver once the card is live again. Deliberately no
    // capture here — a dormant card must cost zero tmux execs.
    if (!name) { enqueue(id, text); return 'deferred'; }
    const sock = socket ?? socketFor?.(id) ?? '';
    if (!(await composerIsClear(name, sock))) { enqueue(id, text); return 'deferred'; }
    try {
      await sendText(name, text, sock);
    } catch {
      // The pane died between the capture and the paste. Queue rather than
      // drop — a lost paste must not be a lost notification.
      enqueue(id, text);
      return 'deferred';
    }
    return 'sent';
  }

  // Re-check every card holding queued lines and deliver those whose composer
  // has since cleared, as ONE paste each. Costs nothing when the map is empty,
  // which is the normal state. Returns the ids delivered.
  async function drain() {
    const delivered = [];
    for (const id of [...pending.keys()]) {
      if (inFlight.has(id)) continue;
      const q = pending.get(id);
      if (!q?.length) { pending.delete(id); continue; }
      const name = tmuxFor?.(id) ?? null;
      if (!name) continue;
      const sock = socketFor?.(id) ?? '';
      inFlight.add(id);
      try {
        if (!(await composerIsClear(name, sock))) continue;
        // Snapshot before the await: anything enqueued while the paste is in
        // flight belongs to the next drain, not this one.
        const lines = [...q];
        // One bracketed paste (pasteBlock), so a backlog arrives as a single
        // turn — two back-to-back pastes to one pane interleave, which is the
        // same hazard index.js's checkStatusKeys suppression already guards.
        await sendText(name, lines.join('\n'), sock);
        const rest = pending.get(id).slice(lines.length);
        if (rest.length) pending.set(id, rest);
        else pending.delete(id);
        delivered.push(id);
      } catch {
        // Keep the queue; the next drain retries.
      } finally {
        inFlight.delete(id);
      }
    }
    return delivered;
  }

  return {
    deliverOrDefer,
    drain,
    pending: (id) => [...(pending.get(id) || [])],
    pendingCount: () => [...pending.values()].reduce((n, q) => n + q.length, 0),
  };
}
