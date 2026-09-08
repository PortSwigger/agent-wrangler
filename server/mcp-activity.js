// When did each card id's MCP client last speak to this server's /mcp endpoint?
//
// Both agents' clients connect (initialize + tools/list) as part of their own
// boot — measured ~1s after launch, Claude carrying X-AW-Session and Codex its
// bearer token — so the first request a freshly-relaunched process makes is the
// only externally observable proof that this server's tools are live INSIDE that
// process. `deliverMailNotification` waits on it before starting the turn that
// reads the mail; see CLAUDE.md for why a turn started any earlier is told every
// MCP tool has been removed.
//
// Deliberately a bare timestamp, not a "has this card ever connected" boolean:
// the question is always "has it connected SINCE the relaunch I just started",
// and any card that was live an hour ago would answer a boolean yes.
//
// The card id is the ADVISORY caller identity (extractCaller — same posture as
// the rest of /mcp: the origin gate accepts the request, the id only attributes
// it), so a localhost process could stamp someone else's card. The blast radius
// is one early paste into that card's own pane, which is the pre-gate behaviour
// — never mail delivered anywhere it wasn't addressed.
//
// Process-local and NOT persisted — it describes the currently-running agent
// process, so a value that outlived this server would be a lie. One number per
// card id seen since startup, so it needs no eviction.
const seen = new Map();

export function noteMcpCaller(caller, at = Date.now()) {
  if (!caller) return; // an unidentified request belongs to no card
  seen.set(caller, at);
}

export function mcpSeenAt(caller) {
  return (caller && seen.get(caller)) || 0;
}
