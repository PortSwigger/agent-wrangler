import fsp from 'node:fs/promises';
import { findTranscript as realFindTranscript } from '../../transcript-reader.js';
import { createChatScanner } from '../../chat-events.js';

// The first open reads only the trailing slice of the transcript. sinceOffset
// bounds the TAIL; without this bound, opening a months-old session parses and
// ships its whole history before the view can draw anything.
export const WINDOW_BYTES = 256 * 1024;

// On-demand, uncached read of one session's conversation. A fresh, TARGETED reply
// to the requesting client only (like subagent-detail / get-memory), never
// broadcast — only the reader of this session needs it. findTranscript is a ctx
// seam for test isolation.
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
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, events: [], offset: 0, more: false, pending: null });
      return;
    }

    let size = 0;
    try {
      size = (await fsp.stat(file)).size;
    } catch {
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, events: [], offset: 0, more: false, pending: null });
      return;
    }

    const since = Number.isFinite(msg.sinceOffset) ? Math.max(0, Math.min(msg.sinceOffset, size)) : null;
    let start = since ?? Math.max(0, size - WINDOW_BYTES);
    const windowed = since == null && start > 0;

    const handle = await fsp.open(file, 'r');
    try {
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
          // A window with no newline at all: nothing parseable, but the caller
          // still needs a resumable offset.
          ctx.reply({ type: 'chat', sessionId: msg.sessionId, events: [], offset: size, more: true, pending: null });
          return;
        }
        from = nl + 1;
      }
      // A trailing partial line is normal for a live session — stop at the last
      // complete newline and leave the remainder for the next poll.
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < from) {
        // No complete line in range. Resume from the line boundary we found, so
        // the next poll does not re-read the partial head.
        ctx.reply({ type: 'chat', sessionId: msg.sessionId, events: [], offset: start + from, more: windowed, pending: null });
        return;
      }
      const complete = buf.subarray(from, lastNl + 1).toString('utf8');
      const scanner = createChatScanner(agent);
      const events = [];
      for (const line of complete.split('\n')) events.push(...scanner.push(line));
      const offset = start + lastNl + 1;
      ctx.reply({ type: 'chat', sessionId: msg.sessionId, events, offset, more: windowed, pending: scanner.pending() });
    } finally {
      await handle.close();
    }
  },
};
