import { sendKeys as realSendKeys, capturePaneStyled as realCapture, clearComposer as realClearComposer, sendText as realSendText } from '../../tmux-scraper.js';
import { paneComposerDraft, paneHasQueuedHint } from '../../ghost-suggestion.js';

export const UNQUEUE_SETTLE_MS = 700;
export const UNQUEUE_POLL_MS = 100;

// Pull the prompts waiting in the agent's own queue back out, so the chat view can
// hand them to the human to edit instead of leaving them to run.
//
// Claude Code only: its Up key moves EVERY queued prompt into the composer
// (newline-separated), emptying the queue — verified against a live pane. That is
// only true while the hint "Press up to edit queued messages" is on screen, i.e.
// the queue is non-empty and the composer is empty. Without it Up walks the prompt
// history instead and would load an old prompt as if it were queued, so the key is
// never sent unless the hint is seen first. Codex's Up only cycles its history
// (the queue is left intact), so there is nothing to pull back there.
//
// Up always empties the WHOLE queue, so dismissing one prompt of several is done by
// pulling them all back, then re-queueing the others in order. The client says
// what it believes is queued (`queue`) and which one is being dismissed (`index`);
// that is only trusted when the text pulled back is exactly that queue — anything
// else in it (a prompt typed in the terminal, an attachment) means the client's
// picture is wrong, so everything is handed back instead (`scope: 'all'`).
//
// `source` says what happened: 'pane' (text pulled back, the pane composer is
// cleared again), 'drained' (nothing queued any more — the agent already took it),
// or 'unsupported' (this agent cannot give a queued prompt back).
export const unqueueHandler = {
  type: 'unqueue',
  async handler(msg, ctx) {
    const sendKeys = ctx.sendKeys || realSendKeys;
    const capturePaneStyled = ctx.capturePaneStyled || realCapture;
    const clearComposer = ctx.clearComposer || realClearComposer;
    const sendText = ctx.sendText || realSendText;
    const settleMs = Number.isFinite(ctx.unqueueSettleMs) ? ctx.unqueueSettleMs : UNQUEUE_SETTLE_MS;
    const pollMs = Number.isFinite(ctx.unqueuePollMs) ? ctx.unqueuePollMs : UNQUEUE_POLL_MS;
    const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const reply = (text, source, extra = {}) => ctx.reply({ type: 'unqueue-result', sessionId: msg.sessionId, token: msg.token ?? null, text, source, ...extra });

    const target = ctx.tmuxFor?.(msg.sessionId);
    if (!target) { reply(null, 'drained'); return; }
    const socket = ctx.socketFor?.(msg.sessionId) || '';
    const agent = (ctx.sessionFromGraph?.(msg.sessionId)?.agent || ctx.sessionManager?.entryFor?.(msg.sessionId)?.agent) === 'codex' ? 'codex' : 'claude';
    if (agent === 'codex') { reply(null, 'unsupported'); return; }

    if (!paneHasQueuedHint(await capturePaneStyled(target, 14, socket))) { reply(null, 'drained'); return; }
    await sendKeys(target, ['Up'], socket);
    let text = null;
    for (let waited = 0; waited <= settleMs; waited += pollMs) {
      text = paneComposerDraft(await capturePaneStyled(target, 14, socket), { lineBreaks: true });
      if (text) break;
      if (waited + pollMs <= settleMs) await sleep(pollMs);
    }
    if (!text) { reply(null, 'drained'); return; }
    // The text is the chat view's now; leaving it in the pane would fuse it onto
    // whatever is pasted next.
    const queue = Array.isArray(msg.queue) && msg.queue.every((t) => typeof t === 'string') ? msg.queue : null;
    const index = Number.isInteger(msg.index) ? msg.index : -1;
    const one = queue && index >= 0 && index < queue.length && queue.length > 1 && text === queue.join('\n');
    const cleared = await clearComposer(target, socket);
    if (!one) { reply(text, 'pane', { cleared: cleared === true, scope: 'all' }); return; }
    // Not re-queued onto a composer that could not be emptied: the pasted text would
    // fuse with what is left in it.
    if (cleared !== true) { reply(text, 'pane', { cleared: false, scope: 'all' }); return; }
    for (const [i, t] of queue.entries()) if (i !== index) await sendText(target, t, socket);
    reply(queue[index], 'pane', { cleared: true, scope: 'one' });
  },
};
