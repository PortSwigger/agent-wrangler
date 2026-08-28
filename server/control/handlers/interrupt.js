import { sendKeys as realSendKeys, capturePaneStyled as realCapture } from '../../tmux-scraper.js';
import { findTranscript as realFindTranscript } from '../../transcript-reader.js';
import { paneComposerDraft } from '../../ghost-suggestion.js';
import { lastUserPrompt, chooseRestore } from '../../restore-prompt.js';

// How long to give Claude Code to restore the interrupted prompt into its own
// composer before giving up and using the transcript instead. Short on purpose:
// the restore is unreliable (see restore-prompt.js), so the common outcome is that
// nothing appears and this whole window is dead time in front of the human. The
// transcript fallback is exact, so losing the race costs correctness nothing —
// only the ability to see an edit made in the pane.
export const RESTORE_SETTLE_MS = 700;
export const RESTORE_POLL_MS = 150;

// Stop the current turn from the chat composer, and answer with the prompt to put
// back in the composer for editing.
//
// Escape is what both TUIs read as "interrupt", so that part stays agent-agnostic;
// if the two ever diverge, the key belongs in the agent adapter, not here. Reading
// the prompt back is Claude-only, because the pane parsing is Claude's TUI and
// guessing at Codex's would be exactly the wrong-text failure this is built to
// avoid — Codex still gets the interrupt and the transcript fallback.
//
// The reply is what the chat view loads; it never uses its own last-polled value
// for this any more, which is what removes the "restored the previous prompt" race.
export const interruptHandler = {
  type: 'interrupt',
  async handler(msg, ctx) {
    const sendKeys = ctx.sendKeys || realSendKeys;
    const capturePaneStyled = ctx.capturePaneStyled || realCapture;
    const findTranscript = ctx.findTranscript || realFindTranscript;
    const settleMs = Number.isFinite(ctx.restoreSettleMs) ? ctx.restoreSettleMs : RESTORE_SETTLE_MS;
    const pollMs = Number.isFinite(ctx.restorePollMs) ? ctx.restorePollMs : RESTORE_POLL_MS;
    const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    const reply = (text, source) => ctx.reply({
      type: 'interrupt-restore',
      sessionId: msg.sessionId,
      // Echoed for the same reason chat.js echoes one: the control socket does not
      // await its handlers, so a reply for a session the view has since left must
      // be droppable by the client rather than typed into the wrong composer.
      token: msg.token ?? null,
      text,
      source,
    });

    const target = ctx.tmuxFor?.(msg.sessionId);
    // Dormant or archived: nothing to interrupt, and no pane to read. Still answer,
    // so the client is never left waiting on a reply that will not come.
    if (!target) { reply(null, 'none'); return; }
    const socket = ctx.socketFor?.(msg.sessionId) || '';
    // The interrupt goes FIRST and is never delayed by the reading below — stopping
    // the turn is the part the human actually pressed the key for.
    await sendKeys(target, ['Escape'], socket);

    const node = ctx.sessionFromGraph?.(msg.sessionId);
    const entry = ctx.sessionManager?.entryFor?.(msg.sessionId);
    const agent = (node?.agent || entry?.agent) === 'codex' ? 'codex' : 'claude';

    // Poll rather than sleep-then-look: when the restore does happen there is no
    // point making the human wait out the rest of the window for it.
    let paneDraft = null;
    if (agent === 'claude') {
      for (let waited = 0; waited <= settleMs; waited += pollMs) {
        paneDraft = paneComposerDraft(await capturePaneStyled(target, 14, socket));
        if (paneDraft) break;
        if (waited + pollMs <= settleMs) await sleep(pollMs);
      }
    }

    let transcriptPrompt = null;
    // Skipped entirely when the pane already answered — the tail read is the more
    // expensive of the two and nothing would use its result.
    if (!paneDraft) {
      // Card id → conversation id, graph → entry → card id, the same precedence
      // chat.js documents: a dormant node omits liveSessionId, and a legacy entry
      // has none at all.
      const convId = node?.liveSessionId || entry?.liveSessionId || msg.sessionId;
      // readTranscriptTail is a ctx seam for tests only (like findTranscript);
      // production leaves it unset and lastUserPrompt does its own bounded read.
      transcriptPrompt = await lastUserPrompt(await findTranscript(convId), agent,
        ctx.readTranscriptTail ? { readTail: ctx.readTranscriptTail } : undefined);
    }

    const { text, source } = chooseRestore({ paneDraft, transcriptPrompt });
    reply(text, source);
  },
};
