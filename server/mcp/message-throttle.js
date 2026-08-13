// Backstop against inter-session reply loops. The prose framing (see send-message.js)
// is the primary defence — this just guarantees a runaway can't burn tokens forever
// if two agents each keep deciding a reply is warranted.
//
// Keyed on the UNORDERED pair {from,to} so an A↔B ping-pong is measured as one
// conversation regardless of direction: at most maxPerWindow delivered messages per
// rolling windowMs — catches a loop that paces itself steadily (e.g. one every 5s
// would otherwise run forever).
//
// There is deliberately no cooldown between individual messages. It used to gate a
// second message arriving too soon after the first, but under the mailbox (Phase 1
// "you've got mail") the settle window keys on the RECIPIENT alone and already
// batches a burst from one sender into a single notification — nothing is lost by
// letting several messages through quickly, so the cooldown had no remaining job
// beyond refusing the 2nd/3rd message of a legitimate burst. Its one useful line —
// don't reply just to acknowledge — is folded into the rate-limit error below, which
// is what actually fires on a loop.
// Only DELIVERED messages are recorded (commit()), so rejected attempts don't
// extend the window. State is in-memory on the long-lived server process; the MCP
// request handler is stateless but shares this instance through deps.
export const WINDOW_MS = 60_000;
export const MAX_PER_WINDOW = 6;

export function createMessageThrottle({
  windowMs = WINDOW_MS,
  maxPerWindow = MAX_PER_WINDOW,
  now = () => Date.now(),
} = {}) {
  const hits = new Map(); // pairKey -> number[] (delivery timestamps, within window)
  const pairKey = (a, b) => [a, b].sort().join('\0');

  // Returns { ok: true, commit } to record the delivery on success, or
  // { ok: false, error } with an agent-facing explanation to return to the sender.
  function check(from, to) {
    const t = now();
    const key = pairKey(from, to);
    const recent = (hits.get(key) || []).filter((ts) => t - ts < windowMs);

    if (recent.length >= maxPerWindow) {
      return {
        ok: false,
        error: `Rate limited: too many messages with this session recently (max ${maxPerWindow} `
          + `per ${Math.round(windowMs / 1000)}s). This usually means a reply loop — stop unless `
          + 'you have substantive new information they need. If you were only acknowledging, do '
          + 'not reply at all.',
      };
    }
    return {
      ok: true,
      commit: () => { recent.push(t); hits.set(key, recent); },
    };
  }

  return { check };
}
