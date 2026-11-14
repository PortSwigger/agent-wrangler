const truthy = (v) => v != null && !['', '0', 'false', 'no'].includes(String(v).toLowerCase());

// Deck-only mode (AW_DECK_ONLY): the deck API on its own port and no board
// server, so another machine's or another instance's board can show its sessions.
export function deckOnly() {
  return truthy(process.env.AW_DECK_ONLY);
}

// The board's port. AW_PORT first to match index.js's bind precedence (instance
// isolation): a dev instance started with AW_PORT must inject *that* port.
export function boardPort() {
  return Number(process.env.AW_PORT) || Number(process.env.PORT) || 7878;
}

// The deck's own port, where the board talks to it cross-origin. AW_DECK_PORT,
// or the board's port plus one so a dev instance on a free AW_PORT gets its own.
export function deckPort() {
  return Number(process.env.AW_DECK_PORT) || boardPort() + 1;
}

// The session API's port: where launched sessions reach /mcp, /pr-attach and
// /pr-model. The port it actually bound once listening (setSessionApiPort),
// else AW_SESSION_API_PORT, else the deck's port plus one, with or without a board.
let sessionApiListenPort = null;
export function setSessionApiPort(port) {
  sessionApiListenPort = port;
}
export function sessionApiPort() {
  return sessionApiListenPort ?? (Number(process.env.AW_SESSION_API_PORT) || deckPort() + 1);
}

// The interface the server binds to. Loopback by default — /ws, /pty, and /mcp
// can launch arbitrary processes, so the dashboard must never be reachable off
// the host. AW_BIND_HOST is a deliberate opt-in for the user who actually wants
// LAN access (e.g. 0.0.0.0); absent it we stay on 127.0.0.1.
export function bindHost() {
  return process.env.AW_BIND_HOST || '127.0.0.1';
}
