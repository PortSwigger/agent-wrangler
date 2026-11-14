import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listStyles, assetPath } from './styles.js';
import { isAllowedOrigin } from './origin-check.js';
import { warnLegacy } from './deck/legacy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

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
  '.woff2': 'font/woff2',
};

// The board server, on the board's own port: the board's HTML and scripts from
// public/, extension board halves under /ext/<id>/, and styles (/api/styles,
// /styles/*), all sent with a Report-Only CSP. Routes that pages and tools
// reached on this origin before the deck had a port of its own are forwarded
// to the deck unchanged, Origin and Host included, so the deck's own gates
// still decide: GET /file, /ext-file and /deck, POST /mcp, /pr-attach and
// /pr-model (for sessions launched before the session API had its own port),
// and the /ws and /pty upgrades.
//
// `extensionAssets(id)` returns the extension's directory or null. Only a LOADED,
// ENABLED extension resolves (index.js binds it to the loader's `dirs`, which
// holds enabled ids alone) — a disabled extension's client must not be served,
// and that membership check, not an id regex, is the whole gate. GET-only static
// content, so no origin gate, same posture as public/.
//
// `extensionThemes()` is the loader's `themeDirs` through `themeSources`
// (enabled extensions only, each with the themes it has switched off), so a
// disabled extension's or switched-off theme drops out of /api/styles and its
// assets 404.
//
// `deckPort()` is where the deck listens on loopback, read per request so the
// page always names the deck's current port.

// Report-Only: extension board halves with inline handlers keep running while
// the browser reports what a strict policy would block.
export const BOARD_CSP = "script-src 'self'; object-src 'none'; base-uri 'self'";

const FORWARDED = {
  GET: new Set(['/file', '/ext-file', '/deck']),
  POST: new Set(['/mcp', '/pr-attach', '/pr-model']),
};
const FORWARDED_UPGRADES = new Set(['/ws', '/pty']);

// The deck API routes a board reaches on the deck's own port; on the board's
// port they work through the forwarder, and say so once. The legacy routes
// (/file, /ext-file, /ws without ?api=) warn on the deck itself.
function warnForwarded(method, pathname, search) {
  if (method === 'GET' && pathname === '/deck') warnLegacy('GET /deck on the board\'s port', 'GET /deck on the deck\'s port');
  else if (pathname === '/pty') warnLegacy('/pty on the board\'s port', '/pty on the deck\'s port');
  else if (pathname === '/ws' && new URLSearchParams(search).has('api')) warnLegacy('/ws?api= on the board\'s port', '/ws?api=1 on the deck\'s port');
}

function rawRequestHead(req) {
  let head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i < req.rawHeaders.length; i += 2) head += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  return `${head}\r\n`;
}

// The board page names the deck's port in a meta tag; no inline script.
export function withDeckPort(html, port) {
  return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n  <meta name="aw-deck-port" content="${Number(port)}" />`);
}

export function createBoardServer({ boardPort, deckPort, extensionAssets = () => null, extensionThemes = () => [] }) {
  const forward = (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: deckPort(), method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }).end('the deck is unreachable');
      else res.destroy();
    });
    req.pipe(up);
  };

  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (FORWARDED[req.method]?.has(urlPath)) {
      warnForwarded(req.method, urlPath, '');
      forward(req, res);
      return;
    }

    res.setHeader('Content-Security-Policy-Report-Only', BOARD_CSP);
    if (urlPath === '/') urlPath = '/index.html';
    // Browsers auto-probe /favicon.ico; serve the bundled SVG so it never 404s.
    // The explicit <link rel=icon> in index.html is what's actually used.
    if (urlPath === '/favicon.ico') urlPath = '/favicon.svg';

    // Custom styles: the compiled manifest list, and a manifest-gated asset route.
    // theme.json is never served — assetPath only resolves manifest-declared assets.
    if (urlPath === '/api/styles') {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ styles: listStyles(extensionThemes()) }));
      return;
    }
    if (urlPath.startsWith('/styles/')) {
      const [id, ...rest] = urlPath.slice('/styles/'.length).split('/');
      const asset = assetPath(id, rest.join('/'), extensionThemes());
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

    if (urlPath.startsWith('/ext/')) {
      const [id, ...rest] = urlPath.slice('/ext/'.length).split('/');
      const base = extensionAssets(id);
      if (!base) {
        res.writeHead(404).end('not found');
        return;
      }
      // Only the extension's public/ subdir is servable (validateManifest holds
      // its `client` to the same subdir). resolve() rather than join(normalize())
      // so a `..` that would climb out — or an absolute segment — fails the
      // prefix check instead of being quietly folded back inside.
      const pubDir = path.join(base, 'public');
      const file = path.resolve(pubDir, rest.join('/'));
      if (!file.startsWith(pubDir + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
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
      res.end(filePath === INDEX_HTML ? withDeckPort(data.toString('utf8'), deckPort()) : data);
    });
  });

  // The /ws and /pty upgrades, piped through to the deck byte for byte. The
  // deck applies its own origin gate; refusing a foreign origin here as well
  // means it never reaches the deck at all.
  server.on('upgrade', (req, socket, head) => {
    const { pathname, search } = new URL(req.url, 'http://localhost');
    if (!FORWARDED_UPGRADES.has(pathname) || !isAllowedOrigin(req.headers.origin, boardPort())) {
      socket.destroy();
      return;
    }
    warnForwarded('GET', pathname, search);
    const up = net.connect(deckPort(), '127.0.0.1', () => {
      up.write(rawRequestHead(req));
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    const end = () => { socket.destroy(); up.destroy(); };
    up.on('error', end);
    socket.on('error', end);
    up.on('close', end);
    socket.on('close', end);
  });

  return server;
}
