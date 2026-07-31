import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listStyles, assetPath } from './styles.js';
import { isAllowedOrigin } from './origin-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// The plain-HTTP server: POST /mcp (CSRF-gated), POST /pr-attach (the launch
// hook's callback), the styles manifest + asset routes, and static public/
// serving. WS upgrades are wired separately on the returned server in index.js.
export function createHttpServer({ port, mcpRequestHandler, prAttachHandler, fileHandler }) {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // Browsers auto-probe /favicon.ico; serve the bundled SVG so it never 404s.
    // The explicit <link rel=icon> in index.html is what's actually used.
    if (urlPath === '/favicon.ico') urlPath = '/favicon.svg';

    if (req.method === 'POST' && (urlPath === '/mcp' || urlPath === '/pr-attach')) {
      // Same CSRF gate as the WS upgrade: a cross-origin POST still fires spawn even
      // when CORS blocks the reply. Absent Origin = a non-browser client (MCP client,
      // or the local PostToolUse hook fetch) → allow.
      if (!isAllowedOrigin(req.headers.origin, port)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      (urlPath === '/mcp' ? mcpRequestHandler : prAttachHandler)(req, res);
      return;
    }

    if (req.method === 'GET' && urlPath === '/file') {
      fileHandler(req, res);
      return;
    }

    // Custom styles: the compiled manifest list, and a manifest-gated asset route.
    // theme.json is never served — assetPath only resolves manifest-declared assets.
    if (urlPath === '/api/styles') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ styles: listStyles() }));
      return;
    }
    if (urlPath.startsWith('/styles/')) {
      const [id, ...rest] = urlPath.slice('/styles/'.length).split('/');
      const asset = assetPath(id, rest.join('/'));
      if (!asset) {
        res.writeHead(404).end('not found');
        return;
      }
      fs.readFile(asset, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(asset)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      // no-store: assets are unversioned, so a service restart with new code must
      // not leave a board running stale JS (the client/server protocol can drift —
      // a stale app.js once turned a fork into a resume). A plain refresh refetches.
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
}
