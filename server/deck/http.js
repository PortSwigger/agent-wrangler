import http from 'node:http';
import { isAllowedOrigin, corsHeaders } from '../origin-check.js';

// The deck's plain-HTTP surface, on its own loopback port: GET /deck (the API
// descriptor, readable cross-origin by the board origins in the allowlist),
// POST /mcp, /pr-attach and /pr-model (the session API's legacy routes, for
// sessions launched before it had its own port; server/session-api), and
// the GET /file and /ext-file adapters. It serves no UI. WS upgrades (/ws, /pty)
// are wired on the returned server in index.js.
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
