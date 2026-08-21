import { adapterFor } from '../../agents/index.js';
import { capturePaneStyled as realCapture, sendText as realSendText } from '../../tmux-scraper.js';
import { paneComposerIsEmpty } from '../../ghost-suggestion.js';

// Switch a live session's model mid-conversation, the way `/model <name>` does in
// the pane — because that IS what this does. Claude Code has no other interface
// for it: the model is session-scoped runtime state, not something the wrangler
// owns, so there is nothing to write and nothing to ask over a socket.
//
// This is a deliberate, narrow exception to "slash commands stay in the pane".
// The rule exists because a slash command's OUTPUT is a TUI dialog the chat view
// cannot render — true of /clear, /compact, /config and the rest. `/model <name>`
// is the case where it does not apply: it takes its argument inline and applies
// silently, with no dialog to miss. Verified against the installed binary, whose
// own help says "/model <name> — session-scoped, not persisted" and whose accepted
// alias list is ["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]",
// "fable[1m]","opusplan"] — a superset of every value the Claude adapter offers,
// so the wrangler's existing model vocabulary maps onto it exactly and no second
// list is introduced here.
//
// Nothing is recorded on the entry. `entry.model` is the LAUNCH model and must
// stay that: it is what a resume re-launches with, and Claude Code does not
// persist a /model change either ("not persisted"), so writing it here would make
// the wrangler claim a durability the agent does not have. The board reflects the
// change through `modelPill`, which is derived from the transcript's own
// `message.model` on the next turn — real confirmation, rather than this handler's
// optimism.
export const setSessionModelHandler = {
  type: 'set-session-model',
  async handler(msg, ctx) {
    const capturePaneStyled = ctx.capturePaneStyled || realCapture;
    const sendText = ctx.sendText || realSendText;
    const fail = (reason) => ctx.reply({ type: 'model-set', sessionId: msg.sessionId, ok: false, reason });

    const node = ctx.sessionFromGraph?.(msg.sessionId);
    const agentId = node?.agent === 'codex' ? 'codex' : 'claude';
    // Claude only. Codex's model is chosen at launch and its TUI is a different
    // program; sending it a Claude slash command would type nonsense into a
    // prompt. Widening this belongs in the agent adapter, not here.
    if (agentId !== 'claude') return fail('Switching model mid-conversation is Claude-only.');

    // Validated against the adapter's own list, so the only strings that can ever
    // reach the pane are ones this codebase already offers at launch — a
    // client-supplied model name is never pasted through unchecked.
    const known = adapterFor('claude').models.some((m) => m.value === msg.model);
    if (!known) return fail('Unknown model.');

    const target = ctx.tmuxFor?.(msg.sessionId);
    if (!target) return fail('Session has no live terminal — resume it first.');
    const socket = ctx.socketFor?.(msg.sessionId) || '';

    // Idle only. A slash command pasted mid-turn is not a command: Claude Code
    // queues composer input as the next PROMPT, so the session would answer
    // "/model sonnet" as a question instead of switching.
    if (node?.status !== 'idle') return fail('Wait until the session is idle.');

    // The paste lands at the cursor, so anything already in the composer would
    // fuse with the command and be submitted as one mangled prompt. Confirmed
    // empty or nothing is sent (paneComposerIsEmpty is false whenever it cannot
    // tell).
    if (!paneComposerIsEmpty(await capturePaneStyled(target, 6, socket))) {
      return fail('Something is typed in the terminal — clear it first.');
    }

    await sendText(target, `/model ${msg.model}`, socket);
    ctx.reply({ type: 'model-set', sessionId: msg.sessionId, ok: true, model: msg.model });
  },
};
