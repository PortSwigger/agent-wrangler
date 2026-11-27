import { isClientToken } from './clients.js';

// The session API's caller check. Every request to /mcp, /pr-attach,
// /pr-model and /status-event goes through a `resolve(req, { legacy })` function that answers
// `{ cardId }` (the one card this request acts as), `{ client }` (an outside
// MCP client the human minted a token for, which is never a card), or
// `{ refuse, reason }` (refuse is a short code, reason a sentence for the log
// and the response body). Nothing else decides who the caller is: handlers get
// the resolved card id or client and never read identity headers themselves.
//
// Credentials a launched session presents:
//   Authorization: Bearer <token>   the session's token (AW_SESSION_TOKEN)
//   X-AW-Session: <card id>         optional claim; when sent it must name the
//                                   token's own card
// An outside client presents only `Authorization: Bearer awc_…` (clients.js),
// accepted only while the session API is bound to loopback and only from a
// loopback peer, never on the legacy routes and never with a card claim.
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
  notLoopback: 'not-loopback',
  notSession: 'not-a-session',
};

// 127.0.0.0/8 and ::1, plain or IPv4-mapped.
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false;
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

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
//
// `clients` is the outside-client store (clients.js) and `boundAddress()` the
// address the session API's listener is bound to; with either missing every
// client token is refused.
export function createLaptopCheck({ tokens, cardState, clients = null, boundAddress = () => null, logWarn = () => {} }) {
  const legacySeen = new Set();

  function outsideClient(req, bearer, claim, legacy) {
    if (!clients || legacy) return refuse(REFUSALS.unknown, 'an outside client token is accepted only on the session API\'s own port');
    if (!isLoopbackAddress(boundAddress())) return refuse(REFUSALS.notLoopback, 'the session API is bound beyond loopback, so outside client tokens are refused');
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) return refuse(REFUSALS.notLoopback, 'an outside client token is accepted only from this machine');
    if (claim) return refuse(REFUSALS.mismatch, 'an outside client cannot claim a card');
    const found = clients.resolve(bearer);
    if (!found.client) return refuse(REFUSALS.unknown, found.reason === 'expired' ? `the outside client "${found.name}" has expired` : 'unknown client token');
    return { client: found.client };
  }

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
    if (isClientToken(bearer)) return outsideClient(req, bearer, claim, legacy);
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
