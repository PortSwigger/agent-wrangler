// Where the board reaches its deck: the deck's own loopback port, named by the
// board server in <meta name="aw-deck-port">, on 127.0.0.1. A board opened from
// another host (an AW_BIND_HOST bind) cannot reach a loopback deck directly,
// so it goes through its own origin, where the board server forwards the deck
// routes.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function deckOrigin(location = globalThis.location, doc = globalThis.document) {
  const port = Number(doc?.querySelector?.('meta[name="aw-deck-port"]')?.getAttribute('content'));
  const secure = location.protocol === 'https:';
  if (!port || !LOOPBACK.has(location.hostname)) {
    return { http: location.origin, ws: `${secure ? 'wss' : 'ws'}://${location.host}` };
  }
  return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}
