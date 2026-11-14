import http from 'node:http';
import { isAllowedOrigin, corsHeaders } from '../origin-check.js';
import { carriesSessionCredential } from '../session-api/check.js';

// The deck's plain-HTTP surface, on its own loopback port: GET /deck (the API
// descriptor, readable cross-origin by the board origins in the allowlist),
// POST /mcp, /pr-attach and /pr-model (the session API's legacy routes, for
// sessions launched before it had its own port; server/session-api), and
// the GET /file and /ext-file adapters. It serves no UI. WS upgrades (/ws, /pty)
// are wired on the returned server in index.js. GET /deck, like /ws and /pty,
// refuses a request carrying a session credential (refuseSessionCredential).
//
// `boardPort` names the board origins the allowlist holds.
export function createDeckServer({ boardPort, mcpRequestHandler, prAttachHandler, prModelHandler, fileHandler, extFileHandler, deckHandler }) {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    const postHandlers = { '/mcp': mcpRequestHandler, '/pr-attach': prAttachHandler, '/pr-model': prModelHandler };
    if (req.method === 'POST' && Object.hasOwn(postHandlers, urlPath)) {
      // Same CSRF gate as the WS upgrade: a cross-origin POST still fires spawn even
      // when CORS blocks the reply. Absent Origin = a non-browser client (MCP client,
      // or the local PostToolUse hook fetch) → allow.
      if (!isAllowedOrigin(req.headers.origin, boardPort)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      postHandlers[urlPath](req, res);
      return;
    }

    if (req.method === 'GET' && urlPath === '/deck') {
      if (carriesSessionCredential(req)) { refuseSessionCredential(res); return; }
      for (const [k, v] of Object.entries(corsHeaders(req.headers.origin, boardPort))) res.setHeader(k, v);
      deckHandler(req, res);
      return;
    }

    if (req.method === 'GET' && urlPath === '/file') {
      fileHandler(req, res);
      return;
    }

    if (req.method === 'GET' && urlPath === '/ext-file') {
      extFileHandler(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'not-found' }));
  });
}

export const SESSION_CREDENTIAL_REFUSAL = { error: 'session-credential', reason: 'the deck API takes no session token; a session calls the session API' };

export function refuseSessionCredential(res) {
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(SESSION_CREDENTIAL_REFUSAL));
}

// The same refusal on a /ws or /pty upgrade, written to the raw socket.
export function refuseSessionCredentialUpgrade(socket) {
  const body = JSON.stringify(SESSION_CREDENTIAL_REFUSAL);
  socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}
