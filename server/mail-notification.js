// The server-authored notification pasted into a recipient's pane at settle
// close. Carries NO sender identity and no body — just a count. Session ids
// were dropped from an earlier draft: a raw id is tokens the recipient can't
// act on directly (it learns the real sender seconds later from `read_mail`'s
// `from` field), so there's nothing to gain from paying for it here.
//
// `[Agent Wrangler]` is the established prefix for a server-originated pane
// paste (see notifier.js's PR nudges) — it marks this as coming from the
// wrangler itself, the trust framing that distinguishes it from a peer's own
// text. The notification starts a turn when idle, or arrives during work through
// Codex input or Claude's socket, and asks the session to read its mailbox.
export function composeMailNotification(messages) {
  const count = messages.length;
  const noun = count === 1 ? 'message' : 'messages';
  return `[Agent Wrangler] 📬 New mail — ${count} ${noun}. Call read_mail now, then continue your work.`;
}
