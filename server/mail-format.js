// Read-time formatting for read_mail/list_mail. Bodies are NEVER truncated at
// write time (mailbox-store always stores the whole body) — truncation is a
// read-time concern only, so a later read_mail({id}) can always recover the
// full text.
const INLINE_LIMIT_BYTES = 4 * 1024;
const BATCH_BUDGET_BYTES = 16 * 1024;
// Preview lengths for the excerpt itself — not specified by the design at the
// byte level (only the inline-vs-excerpt/batch-budget thresholds are), so these
// are a Phase 1 default: enough to recognise the message and decide whether to
// fetch it in full via read_mail({id}).
const DRAIN_EXCERPT_CHARS = 2000;
const LIST_EXCERPT_CHARS = 200;

function excerptOf(body, chars) {
  return body.length > chars ? `${body.slice(0, chars)}…` : body;
}

// Format a batch of drained messages for read_mail(): each message inlines its
// full body UNLESS it alone exceeds the per-message limit, or including it
// would push the running total past the batch budget — once the budget is
// spent, every remaining message degrades to an excerpt even if individually
// small ("overflow degrades to excerpts"). Oldest-first order (as drained) is
// preserved, so the budget is spent in causal order, not by size.
export function formatDrainedMail(messages) {
  let used = 0;
  return messages.map((m) => {
    const overLimit = m.size > INLINE_LIMIT_BYTES;
    const overBudget = used + m.size > BATCH_BUDGET_BYTES;
    const base = { id: m.id, from: m.from, fromLabel: m.fromLabel, at: m.at, size: m.size };
    if (overLimit || overBudget) {
      return { ...base, excerpt: excerptOf(m.body, DRAIN_EXCERPT_CHARS), truncated: true };
    }
    used += m.size;
    return { ...base, body: m.body, truncated: false };
  });
}

// read_mail({id}) — the follow-up path for a truncated body — always returns
// the FULL body regardless of size; there is no degrade case for a single
// explicitly-requested message.
export function formatOneMail(m) {
  return { id: m.id, from: m.from, fromLabel: m.fromLabel, at: m.at, body: m.body, truncated: false, size: m.size };
}

// list_mail — metadata only, never a body, regardless of message size.
export function formatMailMeta(m) {
  return {
    id: m.id, from: m.from, fromLabel: m.fromLabel, at: m.at, size: m.size,
    read: m.state === 'read', state: m.state, excerpt: excerptOf(m.body, LIST_EXCERPT_CHARS),
  };
}
