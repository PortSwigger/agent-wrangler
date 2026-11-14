// A card is one session on one deck, so the board names it by the pair: two
// decks can each hold a session the other does not know about, and only the
// deck id keeps their state apart. A deck id never contains '/'
// (server/deck/deck-id.js), so the first '/' in a key always ends it.
const DECK_ID = /^[A-Za-z0-9-]{1,64}$/;

export function cardKey(deckId, sessionId) {
  if (typeof deckId !== 'string' || !DECK_ID.test(deckId) || typeof sessionId !== 'string' || !sessionId) return null;
  return `${deckId}/${sessionId}`;
}

export function parseCardKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf('/');
  if (i < 1 || i === key.length - 1) return null;
  const deckId = key.slice(0, i);
  return DECK_ID.test(deckId) ? { deckId, sessionId: key.slice(i + 1) } : null;
}

export const keyOf = (ref) => (ref ? cardKey(ref.deckId, ref.sessionId) : null);
export const sessionIdOf = (key) => parseCardKey(key)?.sessionId ?? null;
export const deckIdOf = (key) => parseCardKey(key)?.deckId ?? null;

// Stamps every session record of one deck's graph with that deck's id and the
// card key, in place: records carry their own identity from here on, so no
// later lookup has to know which deck a frame came from.
export function stampDeck(graph, deckId) {
  const stamp = (r) => {
    if (!r || typeof r.sessionId !== 'string') return;
    r.deckId = deckId;
    r.cardKey = cardKey(deckId, r.sessionId);
  };
  if (Array.isArray(graph?.sessions)) graph.sessions.forEach(stamp);
  if (Array.isArray(graph?.nodes)) for (const n of graph.nodes) if (n?.type === 'session') stamp(n);
  return graph;
}
