import fs from 'node:fs';

const MARK_KEYS = { task_started: 'startedAt', task_complete: 'completedAt', turn_aborted: 'abortedAt' };

export function parseTurnMarks(text) {
  const marks = { startedAt: null, completedAt: null, abortedAt: null };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'event_msg') continue;
    const key = MARK_KEYS[record.payload?.type];
    if (!key) continue;
    const at = Date.parse(record.timestamp);
    if (Number.isFinite(at)) marks[key] = at;
  }
  return marks;
}

export async function readTurnMarks(rolloutPath, { tailBytes = 65536, maxBytes = 8 * 1024 * 1024 } = {}) {
  const empty = { startedAt: null, completedAt: null, abortedAt: null, mtimeMs: null };
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
      const found = Object.values(marks).some((v) => v != null);
      if (found || start === 0 || length >= maxBytes) break;
    }
    return { ...marks, mtimeMs };
  } catch {
    return empty;
  } finally {
    await handle?.close();
  }
}
