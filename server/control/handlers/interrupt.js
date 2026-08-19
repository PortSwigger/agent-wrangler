import { sendKeys as realSendKeys } from '../../tmux-scraper.js';

// Stop the current turn from the chat composer. Escape is what both TUIs read as
// "interrupt", so this stays agent-agnostic; if the two ever diverge, the key
// belongs in the agent adapter, not here. sendKeys is a ctx seam for tests.
export const interruptHandler = {
  type: 'interrupt',
  async handler(msg, ctx) {
    const sendKeys = ctx.sendKeys || realSendKeys;
    const target = ctx.tmuxFor?.(msg.sessionId);
    if (!target) return; // dormant or archived: nothing to interrupt
    await sendKeys(target, ['Escape'], ctx.socketFor?.(msg.sessionId) || '');
  },
};
