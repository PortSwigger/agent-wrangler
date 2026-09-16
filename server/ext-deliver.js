import { deliverMessage as defaultDeliverMessage } from './message-delivery.js';

// `host.deliver`, the `deliver` capability on an extension's façade
// (server/host-api/) — how an extension gets text in front of a session's agent,
// and only if its manifest declared `requires: ['deliver']`.
//
// It exists because an extension CANNOT reach the pane itself: everything under
// server/extensions/** must stay leaf-compatible (no tmux-scraper, no
// session-manager — extensions/index.test.js asserts it by regex), so the one
// primitive that knows how to paste into a live pane and how to wake a dormant
// one, message-delivery.js, is imported HERE and handed in bound. Same shape as
// `stores`: the extension reaches server state only through the bag.
//
// The signature is deliberately TWO arguments and no options, and that narrowness
// is the access control — the same reasoning as the checklist tools taking no
// `session` parameter:
//   - `imagePaths` takes ABSOLUTE paths straight to a pane. They are only ever
//     safe because paste-store.js mints and existence-checks them inside one
//     session's own pastes dir; handing an extension that channel would make any
//     file on the box readable by an agent, off a string the extension chose.
//   - `clearComposer` empties the pane before pasting. It means one thing only —
//     the chat view's Esc-then-edit flow, where the wrangler's own interrupt put
//     the restored prompt there — and an extension clearing a human's half-typed
//     draft is a bug with no legitimate caller.
// A future option an extension genuinely needs is a deliberate widening here,
// not something a caller can pass through.
//
// Delivery is ADDRESSED, not a notification: it pastes into a live pane, wakes a
// dormant/suspended card and delivers after the relaunch, and REFUSES an archived
// one (resume() would resurrect a card that left the board on purpose) — every
// route reported back as { mode: 'live' | 'dormant' } | { mode: 'error', error }
// so the extension can say what happened instead of guessing. An extension whose
// text is an automated NOTIFICATION rather than something a human or peer
// addressed (a nudge off a poll, say) wants the mid-prompt hold that the
// notifier's pane pastes use, not this — a paste lands at the composer's cursor,
// so an unsolicited one splices itself into a draft someone is mid-way through
// typing. That gate is not wired into this hook: it belongs to the automated
// callers, and nothing here can tell the two intents apart.
//
// The relaunch of a dormant target is logged with reason=`ext:<id>` rather than
// message: the resume log line exists to name WHAT woke a card, and 'message'
// would read as a human pressing send. It is bound PER EXTENSION — index.js calls
// this once per façade with the extension's own id — which is the whole gain over
// the pre-façade shared bag, where one `reason: 'extension'` named nothing. The
// `reason` is closed over here and is not a caller-passable argument, the same
// forced-value rule the façade's broadcast type and mail `from` follow.
export function createExtDeliver(deps, { deliverMessage = defaultDeliverMessage, reason = 'extension' } = {}) {
  return async function deliver(sessionId, text) {
    if (typeof sessionId !== 'string' || !sessionId) return { mode: 'error', error: 'deliver(sessionId, text): sessionId must be a card id.' };
    if (typeof text !== 'string' || !text.trim()) return { mode: 'error', error: 'deliver(sessionId, text): text must be a non-empty string.' };
    return deliverMessage(sessionId, text, deps, { reason });
  };
}
