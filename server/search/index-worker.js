import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { extractLine } from './extract.js';
import { foldInto } from './fold.js';
import { RECORD_SIZE, writeRecord } from './records.js';

// The parse half of an index build, run off the main thread: read one transcript
// (or just its unread tail), throw away everything that isn't conversation, and
// hand back three packed buffers the parent can append verbatim.
//
// Everything expensive about indexing — the read, the JSON.parse per line, the
// UTF-8 encode, the case fold — happens here, N files at a time. The parent only
// concatenates. That's what keeps a cold build wall-clock ≈ (total work / cores)
// instead of a single-threaded slog through 350 MB of JSON.

export const SEPARATOR = 0x00; // record delimiter: cannot occur in a query, so no match can span two messages

// `from` is a byte offset that is always a line boundary (the parent stores the
// offset just past the last complete line it consumed), so a tail read never
// starts mid-line.
export function parseChunk(file, agent, from) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= from) return { text: null, lc: null, records: null, count: 0, consumed: from, meta: {} };
    const raw = Buffer.allocUnsafe(size - from);
    let read = 0;
    while (read < raw.length) {
      const n = fs.readSync(fd, raw, read, raw.length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    // Stop at the last complete line: a live session is appended to while we read,
    // so the tail is routinely a half-written line. Leaving it unconsumed means the
    // next update picks it up whole.
    const lastNl = raw.lastIndexOf(0x0a, read - 1);
    if (lastNl < 0) return { text: null, lc: null, records: null, count: 0, consumed: from, meta: {} };
    const consumed = from + lastNl + 1;
    const body = raw.toString('utf8', 0, lastNl + 1);

    const texts = [];
    const metas = [];
    const meta = {};
    let total = 0;
    let firstTs = 0;
    let lastTs = 0;
    for (const line of body.split('\n')) {
      const got = extractLine(line, agent);
      if (!got) continue;
      if (got.meta) Object.assign(meta, got.meta);
      if (!got.record) continue;
      const buf = Buffer.from(got.record.text, 'utf8');
      texts.push(buf);
      metas.push(got.record);
      total += buf.length + 1; // + separator
      if (got.record.tsSec) {
        if (!firstTs) firstTs = got.record.tsSec;
        lastTs = got.record.tsSec;
      }
    }
    if (!texts.length) return { text: null, lc: null, records: null, count: 0, consumed, meta };

    // Fresh ArrayBuffers (not Buffer's shared pool) so they can be transferred to
    // the parent without a copy.
    const text = new Uint8Array(total);
    const lc = new Uint8Array(total);
    const records = new Uint8Array(texts.length * RECORD_SIZE);
    const recBuf = Buffer.from(records.buffer, records.byteOffset, records.byteLength);
    let at = 0;
    for (let i = 0; i < texts.length; i++) {
      text.set(texts[i], at);
      // Offsets are chunk-relative; the parent rebases them onto the live corpus.
      writeRecord(recBuf, i, { offset: at, len: texts[i].length, docIdx: 0, tsSec: metas[i].tsSec, role: metas[i].role });
      at += texts[i].length;
      text[at++] = SEPARATOR;
    }
    foldInto(text, lc, total);
    meta.firstTs = firstTs;
    meta.lastTs = lastTs;
    return { text, lc, records, count: texts.length, consumed, meta };
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

if (parentPort) {
  parentPort.on('message', (job) => {
    const res = parseChunk(job.file, job.agent, job.from);
    if (!res) {
      parentPort.postMessage({ id: job.id, error: true });
      return;
    }
    const transfer = [res.text, res.lc, res.records].filter(Boolean).map((u) => u.buffer);
    parentPort.postMessage({ id: job.id, ...res }, transfer);
  });
}
