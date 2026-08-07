import { readRecord, recordIndexAt, recordOffset } from './records.js';
import { scanRegion, snippetBounds, charTrimRange } from './scan.js';

// The one implementation of "find hits and turn them into results".
//
// Two call sites share it — the in-process resident scan and the worker slab
// scan — because the filtering rules (role, agent, date) and the exact-count
// semantics have to agree between them, or the same query returns different
// numbers depending on how big the corpus happens to be that day.

export function emptyResult() {
  // `cursor` rides along with the result because hits arrive in increasing offset
  // order — within a slab and across slabs. See recordAt.
  return { hits: [], matches: 0, scanned: 0, perDoc: {}, cursor: 0 };
}

// Which record contains `offset`, exploiting the fact that consecutive hits move
// forward. A dense query ("the" — tens of thousands of hits) would otherwise pay a
// ~13-step binary search per hit, which measurably dominates the scan itself;
// walking the cursor forward is normally 0–1 steps. The binary search is kept as
// the fallback for the first hit and for any non-monotonic call.
function recordAt(recBuf, recCount, offset, out) {
  let i = out.cursor;
  if (i < recCount && recordOffset(recBuf, i) <= offset) {
    while (i + 1 < recCount && recordOffset(recBuf, i + 1) <= offset) i++;
  } else {
    i = recordIndexAt(recBuf, offset, 0, recCount);
  }
  out.cursor = i;
  return i;
}

// Scan [from, to) of `hay` (whose first byte is corpus offset `hayBase`), pushing
// results into `out`. `recBuf` holds the record rows for the range being scanned,
// starting at row `recIndexBase`.
export function collectHits({
  hay, hayBase = 0, needle, from = 0, to = hay.length, wholeWord = false,
  recBuf, recCount, recIndexBase = 0,
  roleMask = 0, docMask = null, since = 0, until = 0, limit = 100,
  out = emptyResult(),
}) {
  scanRegion(hay, needle, {
    from,
    to,
    wholeWord,
    onHit: (at) => {
      const abs = hayBase + at;
      const local = recordAt(recBuf, recCount, abs, out);
      const rec = readRecord(recBuf, local);
      // Filters live inside the hit callback so `matches` counts what the caller
      // could actually have seen, not raw byte occurrences.
      if (roleMask && !(roleMask & (1 << rec.role))) return true;
      if (docMask && !docMask[rec.docIdx]) return true;
      if (since && rec.tsSec && rec.tsSec < since) return true;
      if (until && rec.tsSec && rec.tsSec > until) return true;
      out.matches++;
      out.perDoc[rec.docIdx] = (out.perDoc[rec.docIdx] || 0) + 1;
      // Past the cap we keep scanning but stop collecting: the count stays exact
      // while the payload stays small.
      if (out.hits.length < limit) {
        out.hits.push({
          docIdx: rec.docIdx,
          tsSec: rec.tsSec,
          role: rec.role,
          recOffset: rec.offset,
          recLen: rec.len,
          hitOffset: abs,
          recIdx: recIndexBase + local,
        });
      }
      return true;
    },
  });
  return out;
}

export const SNIPPET_RADIUS = 140;

// Fill in the display fields for one hit from the raw (unfolded) bytes around it.
// `bytes` must cover [sliceStart, sliceStart + bytes.length) of corpus.txt.
export function fillSnippet(hit, bytes, sliceStart, needleLen) {
  const trim = charTrimRange(bytes);
  const slice = bytes.subarray(trim.start, trim.end);
  const sliceBase = sliceStart + trim.start;
  hit.snippet = slice.toString('utf8');
  // Where the match sits inside the snippet, as UTF-16 offsets the browser can
  // slice on directly. Computed here rather than re-found in the UI, which would
  // highlight the wrong occurrence whenever a snippet contains several.
  const hitIn = Math.max(0, hit.hitOffset - sliceBase);
  hit.hitStart = slice.subarray(0, hitIn).toString('utf8').length;
  hit.hitChars = slice.subarray(hitIn, hitIn + needleLen).toString('utf8').length;
  return hit;
}

export function snippetWindow(hit, needleLen) {
  const { start, end } = snippetBounds(hit.recOffset, hit.recLen, hit.hitOffset, needleLen, SNIPPET_RADIUS);
  hit.headTrimmed = start > hit.recOffset;
  hit.tailTrimmed = end < hit.recOffset + hit.recLen;
  return { start, end };
}

// Resident path: the raw corpus is already a Buffer, so a snippet is a slice.
export function attachSnippetsFromBuffer(hits, textBuf, needleLen) {
  for (const h of hits) {
    const { start, end } = snippetWindow(h, needleLen);
    fillSnippet(h, textBuf.subarray(start, end), start, needleLen);
  }
  return hits;
}
