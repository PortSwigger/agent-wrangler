// The scan primitives — pure functions over buffers, so they're testable without
// an index, a worker, or a disk.
//
// The hot loop is Buffer.prototype.indexOf, which is native (SIMD memchr + memcmp)
// and runs at multiple GB/s. Nothing here beats it by being clever; the job is to
// call it correctly at chunk edges and to keep per-hit work off the fast path.

// Word characters for the whole-word option. Every byte ≥ 0x80 counts as a word
// byte so a UTF-8 letter (é, 漢) never reads as a boundary — folding a multi-byte
// letter into "not a word char" would make `whole word` match inside words.
export function isWordByte(b) {
  return (
    (b >= 0x30 && b <= 0x39) || // 0-9
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    b === 0x5f ||               // _
    b >= 0x80                   // any UTF-8 continuation/lead byte
  );
}

// True when a match at [start, start+len) isn't glued to a word character on
// either side. Bytes outside the buffer read as boundaries, which is correct
// here: the corpus separates records with NUL, so a record edge is always a
// boundary anyway.
export function isWholeWordAt(hay, start, len) {
  const before = start > 0 ? hay[start - 1] : 0;
  const after = start + len < hay.length ? hay[start + len] : 0;
  return !isWordByte(before) && !isWordByte(after);
}

// Find every occurrence of `needle` whose START falls in [from, to) of `hay`,
// calling onHit(start) for each. Matches are non-overlapping (grep semantics).
//
// `to` is a bound on where a hit may START, not where the buffer ends — that
// separation is what makes slab-by-slab scanning correct: a slab is read with
// (needle.length - 1) bytes of overlap into the next one, and `to` stops the
// scan before it re-reports a hit the next slab owns.
//
// onHit may return false to stop early. Returns the number of hits found.
export function scanRegion(hay, needle, { from = 0, to = hay.length, wholeWord = false, onHit } = {}) {
  const n = needle.length;
  if (n === 0) return 0;
  let count = 0;
  let i = from;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0 || at >= to) break;
    i = at + n;
    if (wholeWord && !isWholeWordAt(hay, at, n)) continue;
    count++;
    if (onHit && onHit(at) === false) break;
  }
  return count;
}

// A snippet window around a hit, clamped to the message it lives in so a snippet
// can never bleed into the neighbouring conversation.
export function snippetBounds(recStart, recLen, hitStart, hitLen, radius) {
  const recEnd = recStart + recLen;
  let start = Math.max(recStart, hitStart - radius);
  let end = Math.min(recEnd, hitStart + hitLen + radius);
  if (end < start) end = start;
  return { start, end };
}

// Pull the edges in to whole UTF-8 characters. Slicing a byte window mid-sequence
// yields replacement characters (), which look like corruption in the UI.
// Returns indices rather than a slice so callers can keep their own offsets in
// step (a Buffer's byteOffset is meaningless here — allocUnsafe may be pooled).
export function charTrimRange(buf) {
  let start = 0;
  let end = buf.length;
  // A leading continuation byte (10xxxxxx) is the tail of a character that began
  // before the window.
  while (start < end && (buf[start] & 0xc0) === 0x80) start++;
  // A trailing lead byte whose continuation bytes fell outside the window.
  let back = end - 1;
  while (back >= start && (buf[back] & 0xc0) === 0x80) back--;
  if (back >= start) {
    const lead = buf[back];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (back + need > end) end = back;
  }
  return { start, end };
}

export function trimToCharBoundaries(buf) {
  const { start, end } = charTrimRange(buf);
  return buf.subarray(start, end);
}
