// What the server prints once it is listening. A person who ran `agent-wrangler`
// in a terminal gets a short banner (where the board is, where its state lives,
// how to stop it); a supervised or piped run (launchd, systemd, brew services,
// `| cat`) keeps the single timestamped line, so service logs stay terse and
// greppable. Pure, so the decision and the text are testable without a server.

export function startupStyle({ isTTY, supervised }) {
  return isTTY && !supervised ? 'banner' : 'line';
}

export function bannerLines({ version, url, dataDir }) {
  return [
    '',
    `  Agent Wrangler ${version}`,
    '',
    `  ➜  ${url}`,
    '',
    `  State: ${dataDir}`,
    '  Press Ctrl-C to stop',
    '',
  ];
}

// One line for a failed bind, in place of the raw stack an unhandled listen
// error would otherwise print. EADDRINUSE names the fix: another port.
export function listenErrorMessage(err, port) {
  if (err && err.code === 'EADDRINUSE') {
    return `[agent-wrangler] port ${port} is already in use — pass --port <n> (or set AW_PORT) to use another`;
  }
  if (err && err.code === 'EACCES') {
    return `[agent-wrangler] not allowed to listen on port ${port} — pass --port <n> (or set AW_PORT) to use another`;
  }
  return `[agent-wrangler] could not listen on port ${port}: ${err && err.message ? err.message : err}`;
}
