// The server's own listening port. Single source of truth, shared by index.js
// (bind) and the MCP client-config injection, so a launched session always
// points back at the server that spawned it. AW_PORT first to match index.js's
// bind precedence (instance isolation): a dev instance started with AW_PORT must
// inject *that* port, not the default.
export function serverPort() {
  return Number(process.env.AW_PORT) || Number(process.env.PORT) || 7878;
}

// The interface the server binds to. Loopback by default — /ws, /pty, and /mcp
// can launch arbitrary processes, so the dashboard must never be reachable off
// the host. AW_BIND_HOST is a deliberate opt-in for the user who actually wants
// LAN access (e.g. 0.0.0.0); absent it we stay on 127.0.0.1.
export function bindHost() {
  return process.env.AW_BIND_HOST || '127.0.0.1';
}
