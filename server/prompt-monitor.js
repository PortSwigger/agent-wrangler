import fsp from 'node:fs/promises';
import { createChatScanner } from './chat-events.js';
import { findConversationFile } from './conversation-file.js';

// Observe actual transcript turns, so a prompt typed in the agent's terminal has
// the same extension semantics as one sent through the board or MCP. The chat
// scanner already filters tool results, synthetic context, and queued Claude
// prompts, including their later duplicate user turn.
const READ_BYTES = 1024 * 1024;

export function createPromptMonitor(sessionManager, { findFile = findConversationFile, readFile = fsp } = {}) {
  const cursors = new Map(); // card id -> { liveId, agent, file, ino, offset, tail, scanner }
  let running = false;

  async function locate(entry) {
    const liveId = entry.liveSessionId || entry.sessionId;
    const agent = entry.agent === 'codex' ? 'codex' : 'claude';
    const file = await findFile(liveId, agent);
    if (!file) return null;
    const stat = await readFile.stat(file);
    return { liveId, agent, file, stat };
  }

  // At server startup, old turns are history. A conversation created later has
  // no cursor yet and is read from byte zero, which includes its launch prompt.
  async function seed() {
    for (const entry of sessionManager.activeEntries()) {
      try {
        const found = await locate(entry);
        if (!found) continue;
        const { liveId, agent, file, stat } = found;
        cursors.set(entry.sessionId, { liveId, agent, file, ino: stat.ino, offset: stat.size, tail: Buffer.alloc(0), scanner: createChatScanner(agent) });
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }

  async function poll() {
    if (running) return;
    running = true;
    try {
      const entries = sessionManager.activeEntries();
      const active = new Set(entries.map((e) => e.sessionId));
      for (const id of cursors.keys()) if (!active.has(id)) cursors.delete(id);
      for (const entry of entries) {
        let found;
        try { found = await locate(entry); }
        catch (err) { if (err?.code === 'ENOENT') continue; throw err; }
        if (!found) continue;
        const { liveId, agent, file, stat } = found;
        let cursor = cursors.get(entry.sessionId);
        if (!cursor || cursor.liveId !== liveId || cursor.agent !== agent || cursor.file !== file || cursor.ino !== stat.ino || stat.size < cursor.offset) {
          cursor = { liveId, agent, file, ino: stat.ino, offset: 0, tail: Buffer.alloc(0), scanner: createChatScanner(agent) };
          cursors.set(entry.sessionId, cursor);
        }
        if (stat.size === cursor.offset) continue;
        const handle = await readFile.open(file, 'r');
        let bytesRead;
        const buf = Buffer.alloc(Math.min(READ_BYTES, stat.size - cursor.offset));
        try { ({ bytesRead } = await handle.read(buf, 0, buf.length, cursor.offset)); }
        finally { await handle.close(); }
        if (!bytesRead) continue;
        cursor.offset += bytesRead;
        const chunk = Buffer.concat([cursor.tail, buf.subarray(0, bytesRead)]);
        let start = 0;
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] !== 10) continue;
          const line = chunk.subarray(start, i).toString('utf8');
          start = i + 1;
          for (const event of cursor.scanner.push(line)) {
            if (event.kind !== 'user') continue;
            await sessionManager._fireExtHooks('onPrompt', {
              sessionId: entry.sessionId, liveSessionId: liveId, agent,
              entry: sessionManager.entryFor(entry.sessionId),
              text: event.text, images: event.images || [], ts: event.ts,
            });
          }
        }
        cursor.tail = chunk.subarray(start);
      }
    } finally {
      running = false;
    }
  }

  return { seed, poll };
}
