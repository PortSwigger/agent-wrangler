// The deck API's origin gate: it accepts only the board origins in its
// allowlist. Shared by every browser-reachable deck surface: the WebSocket
// upgrade (/ws + /pty), POST /mcp and the CORS answer on GET /deck. WebSockets
// bypass the same-origin policy and carry no preflight, so without this any page
// the user visits could `new WebSocket('ws://localhost:<port>/ws')` and dispatch
// a session (RCE); the /mcp POST likewise fires its side effect cross-origin even
// when CORS blocks the reply. One policy in one place keeps the surfaces from
// drifting.
//
// Absent Origin is ALLOWED on purpose: non-browser callers (the Claude/Codex MCP
// clients, node tools) send no Origin, and browsers ALWAYS send it for WS and
// cross-origin POST — so a real attacker (a browser page) cannot suppress it.
// Rejecting absent-Origin would break legitimate CLI/MCP callers and buys no CSRF
// protection. The allowlist is the board's own loopback origins on the board
// port; AW_ALLOWED_ORIGINS (comma list) widens it.
export function allowedOriginSet(port) {
  const base = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const extra = (process.env.AW_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return new Set([...base, ...extra]);
}

export function isAllowedOrigin(originHeader, port) {
  if (originHeader == null || originHeader === '') return true;
  return allowedOriginSet(port).has(originHeader);
}

// A Host-header allowlist for a browser-reachable GET that returns sensitive
// data (GET /file, GET /deck) and so can't lean on the Origin gate: a same-origin GET
// carries no Origin, and DNS rebinding lets an attacker page reach the loopback
// server as "same origin". The rebound request still arrives with a foreign Host
// header, so pinning Host to the app's own authorities (loopback on our port,
// plus any AW_ALLOWED_ORIGINS hosts) closes it. Absent Host is REJECTED — every
// HTTP/1.1 browser request carries Host, so unlike Origin there's no legitimate
// caller to protect by allowing its absence.
//
// `port` may be a list: the deck answers on its own port and, through the
// board server's forwarders, under the board's authority too.
export function allowedHostSet(port) {
  const base = [port].flat().flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`]);
  const extra = (process.env.AW_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => { try { return new URL(o).host.toLowerCase(); } catch { return null; } })
    .filter(Boolean);
  return new Set([...base, ...extra]);
}

export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  return allowedHostSet(port).has(hostHeader.toLowerCase());
}

// The CORS answer for a deck GET the board reads cross-origin: the request's
// own Origin echoed back when the allowlist holds it, nothing otherwise.
export function corsHeaders(originHeader, port) {
  if (!originHeader || !allowedOriginSet(port).has(originHeader)) return { Vary: 'Origin' };
  return { 'Access-Control-Allow-Origin': originHeader, Vary: 'Origin' };
}
