// Which model row the chat view's model menu should tick.
//
// Pure leaf (imports nothing) so it unit-tests without a DOM, the same split
// chat-group.js / chat-handoff.js / layout.js already use. app.js owns the menu
// itself and the per-card memory this reads.
//
// The problem it solves: the live model comes from the pane's status bar, which
// prints a SHORT name ("Sonnet 5"), while the adapter's rows carry a suffix
// ("Sonnet 5 · 200K context", "Sonnet 5 · 1M context"). The status bar does not
// distinguish the two context sizes, so the label alone genuinely cannot say
// which row is current.

// Decided over the whole set rather than row by row: the ambiguity is a property
// of the set, so a per-row predicate cannot see it and would tick both halves of
// a pair.
//
// `label` is the pane's live label, `models` the adapter's rows, `remembered`
// the value this browser last asked for on this card (a tie-break, not a
// record). Exactly one prefix match ticks outright. Several matches are broken
// by `remembered`, and only while the pane still agrees with it — so a switch
// made directly in the pane self-heals rather than leaving the tick stuck on
// what the board last sent. Anything else ticks nothing: no tick is honest, a
// wrong tick is not.
export function currentModelValue(models, label, remembered) {
  if (!label) return null;
  const matches = (v) => v === label || v.startsWith(`${label} `) || v.startsWith(`${label}·`);
  const hits = (models || []).filter((m) => matches(m.label));
  if (hits.length === 1) return hits[0].value;
  if (hits.length > 1 && hits.some((m) => m.value === remembered)) return remembered;
  return null;
}
