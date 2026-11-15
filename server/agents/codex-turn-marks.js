import fs from 'node:fs';
import { errorKind } from '../turn-outcome.js';

const MARK_KEYS = { task_started: 'startedAt', task_complete: 'completedAt', turn_aborted: 'abortedAt' };

export function parseTurnMarks(text) {
  const marks = { startedAt: null, completedAt: null, abortedAt: null, lastTurn: null };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'event_msg') continue;
    const key = MARK_KEYS[record.payload?.type];
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) continue;
    if (key) marks[key] = at;
    const type = record.payload?.type;
    if (type === 'task_started') marks.lastTurn = null;
    else if (marks.lastTurn?.outcome === 'error') continue;
    else if (type === 'task_complete') marks.lastTurn = { outcome: 'ok', at };
    else if (type === 'turn_aborted') marks.lastTurn = { outcome: 'aborted', at };
    else if (type === 'error') {
      const info = record.payload.codex_error_info;
      const kind = errorKind(info) || errorKind(info && typeof info === 'object' ? Object.keys(info)[0] : null);
      marks.lastTurn = { outcome: 'error', ...(kind ? { errorKind: kind } : {}), at };
    } else if (type === 'agent_message' || type === 'user_message') marks.lastTurn = null;
  }
  return marks;
}

export async function readTurnMarks(rolloutPath, { tailBytes = 65536, maxBytes = 8 * 1024 * 1024 } = {}) {
  const empty = { startedAt: null, completedAt: null, abortedAt: null, lastTurn: null, mtimeMs: null };
  if (!rolloutPath) return empty;
  let handle;
  try {
    handle = await fs.promises.open(rolloutPath, 'r');
    const { size, mtimeMs } = await handle.stat();
    let marks;
    for (let want = tailBytes; ; want *= 2) {
      const length = Math.min(size, want, maxBytes);
      const start = size - length;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl === -1 ? '' : text.slice(nl + 1);
      }
      marks = parseTurnMarks(text);
      if (marks.startedAt != null || start === 0 || length >= maxBytes) break;
    }
    return { ...marks, mtimeMs };
  } catch {
    return empty;
  } finally {
    await handle?.close();
  }
}
