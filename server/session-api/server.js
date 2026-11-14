import http from 'node:http';

export const SESSION_API_ROUTES = ['/mcp', '/pr-attach', '/pr-model'];

// Wraps a `(req, res, cardId)` handler so it runs only for a request `resolve`
// accepts; anything else is answered 403 with the refusal code. `resolve` may
// return a promise.
export function guarded(resolve, handler, { legacy = false, onRefuse = () => {} } = {}) {
  return async function guardedHandler(req, res) {
    let who;
    try {
      who = await resolve(req, { legacy });
    } catch {
      who = { refuse: 'check-failed', reason: 'the caller check failed' };
    }
    if (!who?.cardId) {
      onRefuse(req, who);
      req.resume();
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: who?.refuse || 'forbidden', reason: who?.reason || '' }));
      return;
    }
    handler(req, res, who.cardId);
  };
}

// The session API's own listener: POST /mcp, /pr-attach and /pr-model and
// nothing else, each behind `resolve` with no legacy path. Browsers have no
// business here, so any request carrying an Origin is refused.
export function createSessionApiServer({ resolve, handlers, onRefuse }) {
  const routes = new Map(SESSION_API_ROUTES.map((p) => [p, guarded(resolve, handlers[p], { onRefuse })]));
  return http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const route = req.method === 'POST' ? routes.get(urlPath) : null;
    if (!route) { req.resume(); res.writeHead(404).end(); return; }
    if (req.headers.origin !== undefined) { req.resume(); res.writeHead(403).end('forbidden'); return; }
    route(req, res);
  });
}

// Binds the session API on loopback. A taken default port falls back to one the
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
