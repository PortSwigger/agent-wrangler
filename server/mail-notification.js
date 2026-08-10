// The server-authored notification pasted into a recipient's pane at settle
// close. Carries SESSION IDS ONLY — never a label. `sessionLabel` derives a
// label from `liveTitle`/`aiTitle`/`intent`/`summary`, all agent-generated text;
// a peer session could shape its own label to forge framing in the raw prompt
// stream this gets pasted into (the `textContent` protection that guards the
// board UI does not apply here). Labels are safe in the board DOM and in
// read_mail/list_mail's JSON results — never in this string.
export function composeMailNotification(messages) {
  const count = messages.length;
  const senders = [...new Set(messages.map((m) => m.from))];
  const noun = count === 1 ? 'message' : 'messages';
  return `📬 You've got mail — ${count} new ${noun} (from ${senders.join(', ')}).\n`
    + 'Call read_mail() when you reach a good stopping point.';
}
