// The session API's caller check. Every request to /mcp, /pr-attach and
// /pr-model goes through a `resolve(req, { legacy })` function that answers
// either `{ cardId }` (the one card this request acts as) or
// `{ refuse, reason }` (refuse is a short code, reason a sentence for the log
// and the response body). Nothing else decides who the caller is: handlers get
// the resolved card id and never read identity headers themselves.
//
// Credentials a launched session presents:
//   Authorization: Bearer <token>   the session's token (AW_SESSION_TOKEN)
//   X-AW-Session: <card id>         optional claim; when sent it must name the
//                                   token's own card
//
// `createLaptopCheck` is the single-machine implementation: the token is looked
// up in the token store (tokens.js). Another deployment swaps in its own
// resolve with the same contract; see docs/session-api.md.
//
// `legacy: true` is passed only on the routes sessions launched before tokens
// existed still call (the board and deck ports). There a bare card id is
// accepted, for a live card that has never been issued a token, and logged once
// per card. Every launch issues a token, so a relaunched card leaves that path
// for good.

export const REFUSALS = {
  missing: 'missing-token',
  unknown: 'unknown-token',
  archived: 'archived',
  mismatch: 'claim-mismatch',
};

export function credentialsOf(req) {
  const headers = req?.headers || {};
  const auth = headers.authorization;
  const m = typeof auth === 'string' ? auth.match(/^Bearer\s+(\S+)\s*$/) : null;
  const claim = headers['x-aw-session'];
  return {
    bearer: m ? m[1] : null,
    claim: typeof claim === 'string' && claim.length ? claim : null,
  };
}

// True when a request presents a session credential (a bearer or an
// X-AW-Session claim). The deck's own surfaces (GET /deck, /ws, /pty) refuse
// such a request: a session acts through the session API, as its token's card,
// and never through the board's interface.
export function carriesSessionCredential(req) {
  const { bearer, claim } = credentialsOf(req);
  return Boolean(bearer || claim);
}

const refuse = (code, reason) => ({ refuse: code, reason });

// `cardState(cardId)` answers 'running' (its pane is alive), 'stopped',
// 'archived' or 'unknown' (no such card). A token's card may still be 'unknown'
// for a moment: a session's MCP client can connect before its launch has
// recorded the card, so a token is refused only for an archived card. The
// legacy path takes only a running card: a stopped one has no process that
// could need it, and gets a token when it next launches.
export function createLaptopCheck({ tokens, cardState, logWarn = () => {} }) {
  const legacySeen = new Set();

  function legacyCaller(id) {
    if (tokens.hasToken(id)) return refuse(REFUSALS.unknown, 'this card has a session token; its card id is no longer accepted');
    const state = cardState(id);
    if (state === 'archived') return refuse(REFUSALS.archived, 'the card is archived');
    if (state !== 'running') return refuse(REFUSALS.unknown, 'unknown token');
    if (!legacySeen.has(id)) {
      legacySeen.add(id);
      logWarn(`[session-api] ${id} called without a session token (launched before tokens); accepted until it is relaunched`);
    }
    return { cardId: id, legacy: true };
  }

  return function resolve(req, { legacy = false } = {}) {
    const { bearer, claim } = credentialsOf(req);
    if (bearer) {
      const cardId = tokens.cardFor(bearer);
      if (cardId) {
        if (claim && claim !== cardId) return refuse(REFUSALS.mismatch, 'the caller claim does not match the token\'s card');
        if (cardState(cardId) === 'archived') return refuse(REFUSALS.archived, 'the card is archived');
        return { cardId };
      }
      if (!legacy) return refuse(REFUSALS.unknown, 'unknown token');
      if (claim && claim !== bearer) return refuse(REFUSALS.mismatch, 'the caller claim does not match the token\'s card');
      return legacyCaller(bearer);
    }
    if (!legacy || !claim) return refuse(REFUSALS.missing, 'missing token');
    return legacyCaller(claim);
  };
}
