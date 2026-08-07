// The record table: one fixed-width row per indexed message, describing where that
// message's text sits in the corpus. Fixed width (not JSON) so a worker can pread
// just the slice of rows covering its byte range, and so "which message contains
// byte N?" is a binary search over a flat buffer rather than a parse.
//
// Rows are appended in corpus order, so `offset` is monotonically increasing —
// that invariant is what makes the binary search (and range-splitting the corpus
// across workers by row index) valid. Anything that appends out of order breaks
// lookup silently, so append only via the indexer's single writer.
//
// 20 bytes, little-endian:
//   0  u32 offset    byte offset of the message text in corpus.txt / corpus.lc
//   4  u32 len       byte length of the message text
//   8  u32 docIdx    index into meta.docs (the transcript this came from)
//   12 u32 tsSec     unix seconds (0 if the line carried no timestamp)
//   16 u8  role      ROLE_USER | ROLE_ASSISTANT
//   17 —— pad        keeps the row 4-byte aligned and leaves room to grow

export const RECORD_SIZE = 20;
export const ROLE_USER = 0;
export const ROLE_ASSISTANT = 1;

// u32 offsets cap the corpus at 4 GiB. The indexer refuses to grow past this and
// asks for a rebuild instead of silently wrapping an offset.
export const MAX_CORPUS_BYTES = 0xffffffff;

export function writeRecord(buf, i, { offset, len, docIdx, tsSec, role }) {
  const at = i * RECORD_SIZE;
  buf.writeUInt32LE(offset, at);
  buf.writeUInt32LE(len, at + 4);
  buf.writeUInt32LE(docIdx, at + 8);
  buf.writeUInt32LE(tsSec, at + 12);
  buf.writeUInt8(role, at + 16);
  buf.writeUInt8(0, at + 17);
  buf.writeUInt16LE(0, at + 18);
}

export function readRecord(buf, i) {
  const at = i * RECORD_SIZE;
  return {
    offset: buf.readUInt32LE(at),
    len: buf.readUInt32LE(at + 4),
    docIdx: buf.readUInt32LE(at + 8),
    tsSec: buf.readUInt32LE(at + 12),
    role: buf[at + 16],
  };
}

export function recordOffset(buf, i) {
  return buf.readUInt32LE(i * RECORD_SIZE);
}

// The row whose [offset, offset+len) contains `offset`, searched within
// [lo, hi) of the row buffer. Returns the last row starting at or before the
// offset — callers hand it an offset that is inside a record by construction (it
// came from a hit in that record's bytes), so no containment re-check is done.
export function recordIndexAt(buf, offset, lo, hi) {
  let low = lo;
  let high = hi - 1;
  let best = lo;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (recordOffset(buf, mid) <= offset) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
