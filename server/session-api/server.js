import http from 'node:http';

export const SESSION_API_ROUTES = ['/mcp', '/pr-attach', '/pr-model', '/status-event'];
// The routes the deck's and board's ports still serve for sessions launched
// before the session API had its own port. Newer routes exist only here.
export const LEGACY_ROUTES = ['/mcp', '/pr-attach', '/pr-model'];
// The routes an outside client (check.js `{ client }`) may call. Every other
// route acts as the caller's card, which a client never is.
export const CLIENT_ROUTES = ['/mcp'];

// Wraps a `(req, res, cardId, client)` handler so it runs only for a request
// `resolve` accepts; anything else is answered 403 with the refusal code. A
// card's request gets `(req, res, cardId)`; an outside client's, only where
// `clients` is true, gets `(req, res, null, client)`. `resolve` may return a
// promise.
export function guarded(resolve, handler, { legacy = false, clients = false, onRefuse = () => {} } = {}) {
  return async function guardedHandler(req, res) {
    let who;
    try {
      who = await resolve(req, { legacy });
    } catch {
      who = { refuse: 'check-failed', reason: 'the caller check failed' };
    }
    if (who?.client && !who.cardId && !(clients && !legacy)) who = { refuse: 'not-a-session', reason: 'this route acts as a session, and an outside client is not one' };
    if (!who?.cardId && !who?.client) {
      onRefuse(req, who);
      req.resume();
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: who?.refuse || 'forbidden', reason: who?.reason || '' }));
      return;
    }
    if (who.cardId) handler(req, res, who.cardId);
    else handler(req, res, null, who.client);
  };
}

// The session API's own listener: POST on SESSION_API_ROUTES and nothing else
// (a route with no handler is not served), each behind `resolve` with no legacy path. Browsers have no
// business here, so any request carrying an Origin is refused.
export function createSessionApiServer({ resolve, handlers, onRefuse }) {
  const routes = new Map(SESSION_API_ROUTES.filter((p) => handlers[p]).map((p) => [p, guarded(resolve, handlers[p], { onRefuse, clients: CLIENT_ROUTES.includes(p) })]));
  return http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const route = req.method === 'POST' ? routes.get(urlPath) : null;
    if (!route) { req.resume(); res.writeHead(404).end(); return; }
    if (req.headers.origin !== undefined) { req.resume(); res.writeHead(403).end('forbidden'); return; }
    route(req, res);
  });
}

// Binds the session API (on loopback unless `host` says otherwise). A taken default port falls back to one the
// OS picks; a port set explicitly (`fixed`) is held to. Resolves with the port
// it got; rejects when it cannot bind.
export function listenSessionApi(server, { port, host = '127.0.0.1', fixed = false }) {
  return new Promise((resolve, reject) => {
    let tryPort = port;
    const onError = (err) => {
      if (err?.code === 'EADDRINUSE' && !fixed && tryPort !== 0) {
        tryPort = 0;
        server.listen(0, host);
        return;
      }
      server.off('error', onError);
      reject(Object.assign(err, { port: tryPort }));
    };
    server.on('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
    server.listen(port, host);
  });
}
