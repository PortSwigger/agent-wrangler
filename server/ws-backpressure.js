// Every `ws.send` on a socket the peer has stopped reading is queued in server
// memory, and `readyState` stays OPEN the whole time — a stalled client never
// errors and never closes, so the only thing that grows is `bufferedAmount`.
// That is what OOM-killed the service: `broadcast` sends a FULL graph snapshot
// (measured 2.2 MB) to every client on every rebuild (~2 s), so one suspended
// browser tab accreted 1.07 MB/s and reached V8's ~4 GB heap limit in ~62 min,
// repeatedly. Measured live on the crashing process: one socket OPEN with
// 411 MB buffered across 74 queued messages, `bytesRead` 525 in nine minutes
// (the peer read the handshake and nothing since) against 477 MB written; a
// forced `collectGarbage` freed none of it, because a send queue is reachable,
// not garbage.
//
// TERMINATE rather than skip, for correctness rather than memory. Skipping is
// only safe for full-snapshot messages, and `broadcast` also carries one-shot
// events (`auto-archived`, `memory-changed`, `fd-warning`, `styles`) that
// nothing ever re-sends — a skip-based guard would quietly stop delivering
// those to a slow client, trading an OOM for a subtler bug in the same
// function. A terminated client reconnects and the connect path already
// re-sends config/styles/agents plus a whole graph, so the recovery path is the
// one the board exercises on every reload.
//
// `terminate()`, never `close()`: close initiates a closing handshake the peer
// must acknowledge, and a socket that isn't reading never will — the queue (and
// the memory) would survive the very call meant to release it.
//
// The cap is a multiple of the largest thing we send, not a round number picked
// blind: at the measured 2.2 MB graph it is ~7 pending snapshots, while a
// healthy loopback client measured 0 bytes buffered between ticks. Anything
// above it is a peer that has stopped consuming, not one having a slow moment.
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

// True when this client has fallen so far behind that it must be dropped rather
// than written to again. Split from the sending itself so the threshold is
// unit-testable without a socket (index.js self-runs main() and can't be
// imported; pty-channel needs a live tmux).
export function isOverBuffered(client, limit = MAX_BUFFERED_BYTES) {
  return (client?.bufferedAmount || 0) > limit;
}

// Send unless the client is over its buffer cap, in which case drop it. Returns
// what happened, so a caller can count/log drops. A send that throws (socket
// torn down between the readyState check and the write) reports 'closed' rather
// than propagating — a broadcast must never be aborted part-way through the
// client list by one bad peer.
export function sendGuarded(client, msg, limit = MAX_BUFFERED_BYTES) {
  if (!client || client.readyState !== 1) return 'closed';
  if (isOverBuffered(client, limit)) {
    try {
      client.terminate();
    } catch {
      /* already gone — the 'close' handler still runs and drops it from the set */
    }
    return 'terminated';
  }
  try {
    client.send(msg);
  } catch {
    return 'closed';
  }
  return 'sent';
}
