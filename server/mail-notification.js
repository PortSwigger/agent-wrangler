// The server-authored notification pasted into a recipient's pane at settle
// close. Carries NO sender identity and no body — just a count. Session ids
// were dropped from an earlier draft: a raw id is tokens the recipient can't
// act on directly (it learns the real sender seconds later from `read_mail`'s
// `from` field), so there's nothing to gain from paying for it here.
//
// `[Agent Wrangler]` is the established prefix for a server-originated pane
// paste (see notifier.js's PR nudges) — it marks this as coming from the
// wrangler itself, the trust framing that distinguishes it from a peer's own
// text. No "call read_mail()" instruction here either: the standing
// instruction to read mail at a natural break lives ONCE in the `mail`
// agent-skill's always-on nudge (its sidecar WRANGLER.md, mirroring
// task-memory) rather than being repeated in every notification — see
// agent-skills/skills/mail/WRANGLER.md.
export function composeMailNotification(messages) {
  const count = messages.length;
  const noun = count === 1 ? 'message' : 'messages';
  return `[Agent Wrangler] 📬 New mail — ${count} ${noun}, read when convenient.`;
}
