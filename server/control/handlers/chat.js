import fsp from 'node:fs/promises';
import { findTranscript as realFindTranscript } from '../../transcript-reader.js';
import { createChatScanner } from '../../chat-events.js';

// The first open reads only the trailing slice of the transcript. sinceOffset
// bounds the TAIL; without this bound, opening a months-old session parses and
// ships its whole history before the view can draw anything.
export const WINDOW_BYTES = 256 * 1024;

// A scanner is stateful — pending (open tool calls), model and prevTs only make
// sense for a byte range read CONTIGUOUSLY from a fixed start. Building one fresh
// per request (the pre-fix behaviour) throws that state away every poll, so an
// assistant's tool_use and its tool_result — routinely split across the 2s poll
// interval by however long the tool takes — land in different scanners and the
// tool_result finds no open call to pair with: dropped permanently. Caching one
// scanner per live conversation and reusing it across contiguous polls fixes
// that; see getOrCreateScanner for the reuse condition, which is the one thing
// that has to be exactly right here.
//
// Keyed on the CONVERSATION id (liveSessionId), matching convId below — never the
// card id, so a resume/fork that repoints a card at a different transcript can't
// hand this scanner's state to the wrong stream.
//
// Capped at a small size (oldest entry evicted first) because this is new
// server-side state on a path that previously had none: a session viewed once
// and never revisited must not occupy a slot forever. 50 is comfortably above
// how many sessions are ever open in chat view on one board at once.
const MAX_CACHED_SCANNERS = 50;
const scannerCache = new Map(); // convId -> { scanner, offset, agent }

function touchCache(convId, entry) {
  // Map preserves insertion order; delete-then-set moves this key to the most-
  // recently-used end, turning insertion order into a cheap LRU order.
  scannerCache.delete(convId);
  scannerCache.set(convId, entry);
  if (scannerCache.size > MAX_CACHED_SCANNERS) {
    scannerCache.delete(scannerCache.keys().next().value); // oldest-out
  }
}

// Reuse the cached scanner ONLY when this request's sinceOffset is exactly the
// offset the cache entry last returned. Every other case — no sinceOffset (a
// fresh mount, which deliberately re-reads a window rather than resuming a
// stream), an offset that doesn't match (a second browser polling the same
// session from a different offset, or this one having skipped/rewound), or a
// different agent — gets a brand-new scanner instead.
//
// This is the guard against the worse failure mode than the one being fixed: a
// scanner's `pending` map reflects exactly the tool_use lines it has already
// seen. Handing it to a request that starts from a different offset would
// either re-emit events it already produced (offset behind the cache) or skip
// straight past tool_use lines it never saw (offset ahead), corrupting
// `pending` either way. Matching the offset exactly is what guarantees two
// clients at different points in the stream never share one scanner.
function getOrCreateScanner(convId, since, agent) {
  const cached = scannerCache.get(convId);
  if (cached && since != null && cached.offset === since && cached.agent === agent) {
    touchCache(convId, cached); // mark recently used, keep it alive under LRU pressure
    return cached.scanner;
  }
  return createChatScanner(agent);
}

// On-demand, uncached read of one session's conversation. A fresh, TARGETED reply
// to the requesting client only (like subagent-detail / get-memory), never
// broadcast — only the reader of this session needs it. findTranscript is a ctx
// seam for test isolation.
//
// `token`, like `sessionId`, is echoed back verbatim and unvalidated on EVERY
// reply path below — the server never interprets it. The client (chat-view.js)
// uses it to tell a reply sent under an earlier "mount era" apart from one sent
// under the current era, which the sessionId alone can't do (reopening the same
// session keeps the id but not the era) and which arrival order can't do either,
// since concurrent `chat` requests are not awaited in series (server/index.js's
// ws 'message' handler) and can complete out of order. Every early return here
// must carry it too, or a reply missing it looks to the client like the session
// silently stopped updating.
export const chatHandler = {
  type: 'chat',
  async handler(msg, ctx) {
    const findTranscript = ctx.findTranscript || realFindTranscript;
    // The client sends the CARD id; the transcript is named by the CONVERSATION
    // id. Resolve card → liveSessionId off the graph, falling back to the card id
    // for legacy pre-split entries — the same resolution subagent-detail.js does.
    const node = ctx.sessionFromGraph?.(msg.sessionId);
    const convId = node?.liveSessionId || msg.sessionId;
    const agent = node?.agent === 'codex' ? 'codex' : 'claude';

    const file = await findTranscript(convId);
    if (!file) {
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, token: msg.token ?? null, events: [], offset: 0, more: false, pending: null });
      return;
    }

    let size = 0;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, token: msg.token ?? null, events: [], offset: 0, more: false, pending: null });
      return;
    }

    const since = Number.isFinite(msg.sinceOffset) ? Math.max(0, Math.min(msg.sinceOffset, size)) : null;
    let start = since ?? Math.max(0, size - WINDOW_BYTES);
    let windowed = since == null && start > 0;

    let handle;
    try {
      handle = await fsp.open(file, 'r');
    } catch {
      // Deleted/unreadable between the stat above and this open — degrade the
      // same way a missing file or a failed stat does, never throw.
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, token: msg.token ?? null, events: [], offset: 0, more: false, pending: null });
      return;
    }
    try {
      // At most two passes: the widen below flips `windowed` to false, and the
      // widen condition requires `windowed` to be true, so it cannot re-fire.
      for (;;) {
        const len = size - start;
        const buf = Buffer.alloc(len);
        await handle.read(buf, 0, len, start);
        // Byte arithmetic, NOT string slicing. A windowed read can begin mid
        // multi-byte character; decoding first would turn those bytes into U+FFFD,
        // whose re-encoded byteLength no longer matches what was consumed —
        // misaligning `offset`, which lands the NEXT poll mid-line (that poll trusts
        // its start to be a line boundary and does not re-skip) and silently drops
        // an event. 0x0A is '\n', and it cannot occur inside a multi-byte sequence.
        let from = 0;
        if (windowed) {
          const nl = buf.indexOf(0x0a);
          if (nl === -1) {
            // The window holds not even one newline: a single jsonl line (e.g. a
            // huge tool Read result) can exceed WINDOW_BYTES on its own. Replying
            // with offset: size here would permanently discard those bytes — the
            // next poll starts past them and never looks again, even once the line
            // is terminated. Widen to the whole file instead of narrowing further.
            start = 0;
            windowed = false;
            continue;
          }
          from = nl + 1;
        }
        // A trailing partial line is normal for a live session — stop at the last
        // complete newline and leave the remainder for the next poll.
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl < from) {
          // No complete line in range. Resume from the line boundary we found, so
          // the next poll does not re-read the partial head.
          ctx.reply({ type: 'chat', sessionId: msg.sessionId, token: msg.token ?? null, events: [], offset: start + from, more: windowed, pending: null });
          return;
        }
        const complete = buf.subarray(from, lastNl + 1).toString('utf8');
        const scanner = getOrCreateScanner(convId, since, agent);
        const events = [];
        for (const line of complete.split('\n')) events.push(...scanner.push(line));
        const offset = start + lastNl + 1;
        // Cache under the offset just produced (not `since`) — that is the value a
        // contiguous follow-up poll will send back as ITS sinceOffset, which is
        // exactly the match getOrCreateScanner needs to reuse this scanner next time.
        touchCache(convId, { scanner, offset, agent });
        ctx.reply({ type: 'chat', sessionId: msg.sessionId, token: msg.token ?? null, events, offset, more: windowed, pending: scanner.pending() });
        return;
      }
    } finally {
      await handle.close();
    }
  },
};
