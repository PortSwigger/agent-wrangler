// Case folding done at the BYTE level, on purpose.
//
// The whole search design rests on one property: the folded copy of the corpus is
// byte-for-byte the same LENGTH as the original, so a hit found at offset N in
// `corpus.lc` is the same hit at offset N in `corpus.txt`. That is what lets a
// case-insensitive scan run over the folded buffer while snippets (with their
// original casing) come straight out of the raw one — no re-mapping table, no
// second parse.
//
// String.prototype.toLowerCase() CANNOT be used for this: it is length-changing
// ('İ' → 'i̇', 'ẞ' → 'ß' in some engines), which would desync every offset after it.
// So we fold only the two ranges where lowercasing is guaranteed length-preserving
// in UTF-8:
//   • ASCII        A–Z            (0x41–0x5A)            → +0x20
//   • Latin-1 sup. À–Þ            (0xC3 0x80–0x9E)       → second byte +0x20
// Latin-1's 0xC3 0x97 is × (multiplication sign), not a letter — skipped, else it
// would fold to ÷.
//
// Everything else (Greek, Cyrillic, Turkish dotted I, …) is left alone, so a
// case-insensitive search over non-Latin text behaves like a case-sensitive one.
// That is a deliberate POC limitation, not an oversight: correct full Unicode
// folding is length-changing and needs an offset map.

const UP_A = 0x41;
const UP_Z = 0x5a;
const C3 = 0xc3;
const MULT_SIGN = 0x97; // 0xC3 0x97 = ×, the one non-letter in the Latin-1 upper range

// Fold `src` into `dst` (which must be at least as long). Same-length by
// construction. Passing src as dst folds in place. Returns dst.
export function foldInto(src, dst, len = src.length) {
  for (let i = 0; i < len; i++) {
    const b = src[i];
    if (b >= UP_A && b <= UP_Z) {
      dst[i] = b + 0x20;
    } else if (b === C3 && i + 1 < len) {
      const n = src[i + 1];
      dst[i] = C3;
      dst[i + 1] = n >= 0x80 && n <= 0x9e && n !== MULT_SIGN ? n + 0x20 : n;
      i++;
    } else if (dst !== src) {
      dst[i] = b;
    }
  }
  return dst;
}

// A folded copy, leaving the source untouched.
export function foldBytes(src) {
  return foldInto(src, Buffer.allocUnsafe(src.length));
}

// The needle a case-insensitive scan looks for: the query folded the same way the
// corpus was, so the two agree byte-for-byte.
export function foldNeedle(str) {
  return foldBytes(Buffer.from(str, 'utf8'));
}
