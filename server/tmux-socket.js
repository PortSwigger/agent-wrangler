import crypto from 'node:crypto';

// Per-install tmux socket isolation. Each install runs its sessions on its own
// generated tmux socket (config.json `tmuxSocket`), so a second instance (a dev
// sandbox with its own AW_DATA_DIR) is isolated by construction. Legacy sessions
// created before this feature have no recorded socket — they live on the default
// socket and are drained as they end or are resumed onto the generated socket.

// `-L <socket>` args for a tmux invocation. An empty/absent name means the default
// socket (no flag), byte-identical to legacy behaviour.
export function tmuxSocketArgs(socketName) {
  return socketName ? ['-L', socketName] : [];
}

// The socket a mapping entry's tmux runs on. A recorded socket wins; absent means
// a legacy (pre-migration) session, which lives on `legacySocket` — the default
// socket ('') in production, overridable for isolated migration testing.
export function socketForEntry(entry, legacySocket = '') {
  return entry?.socket || legacySocket;
}

// Which sockets discovery must scan: always this install's generated socket, plus
// the legacy socket while any non-archived legacy (socket-less) session remains.
// Once those drain, the legacy socket drops out — migration completes on its own.
// `legacySocket` is '' (the real default socket) in production.
export function socketsToScan(entries, instanceSocket, legacySocket = '') {
  const sockets = [instanceSocket];
  const hasLegacy = entries.some((e) => !e?.archivedAt && !e?.socket);
  if (hasLegacy) sockets.push(legacySocket);
  return sockets;
}

// A fresh per-install socket name.
export function generateSocketName() {
  return `aw-${crypto.randomBytes(4).toString('hex')}`;
}
