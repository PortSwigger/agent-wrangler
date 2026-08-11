// The server-authored notification pasted into a recipient's pane at settle
// close. Carries SESSION IDS ONLY — never a label. `sessionLabel` derives a
// label from `liveTitle`/`aiTitle`/`intent`/`summary`, all agent-generated text;
// a peer session could shape its own label to forge framing in the raw prompt
// stream this gets pasted into (the `textContent` protection that guards the
// board UI does not apply here). Labels are safe in the board DOM and in
// read_mail/list_mail's JSON results — never in this string.
//
// `[Agent Wrangler]` is the established prefix for a server-originated pane
// paste (see notifier.js's PR nudges) — it marks this as coming from the
// wrangler itself, not from the sender it names. No "call read_mail()" line:
// the `mail` agent-skill (description keyed on this exact "you've got mail"
// phrase) carries that instruction, plus the no-reply-by-default norm and the
// "finish what you're doing first" guidance — a single source, not duplicated
// here where it can't be updated without a server change.
export function composeMailNotification(messages) {
  const count = messages.length;
  const senders = [...new Set(messages.map((m) => m.from))];
  const noun = count === 1 ? 'message' : 'messages';
  return `[Agent Wrangler] 📬 You've got mail — ${count} new ${noun} (from ${senders.join(', ')}).`;
}
