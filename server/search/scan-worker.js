import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { RECORD_SIZE } from './records.js';
import { collectHits, emptyResult, fillSnippet, snippetWindow, SNIPPET_RADIUS } from './scan-core.js';

// The out-of-process scan path, used when the corpus is too big to keep resident
// (see query.js). One worker owns one contiguous slice of the corpus.
//
// It streams its slice through a reusable slab buffer rather than loading it, so
// a query costs a bounded amount of RSS however large the corpus grows — the
// bytes come from the OS page cache, which is where a hot corpus lives anyway.
//
// Slabs overlap by needle.length + 1 bytes, and collectHits' `to` bound is what
// stops a hit being reported twice: a match straddling a slab edge belongs to the
// slab its FIRST byte falls in, and the overlap exists only so the comparison
// (and the whole-word check on the byte after it) can complete.

const SLAB = 8 * 1024 * 1024;

function preadAll(fd, buf, position, length) {
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
  return read;
}

// job: { needle (base64), corpusFile, textFile, recordsFile, corpusBytes,
//        recStart, recEnd, byteStart, byteEnd, wholeWord, roleMask, docMask,
//        since, until, limit }
export function runScan(job) {
  const needle = Buffer.from(job.needle, 'base64');
  const n = needle.length;
  const recCount = job.recEnd - job.recStart;
  const out = emptyResult();
  if (!n || recCount <= 0 || job.byteEnd <= job.byteStart) return out;

  // Only this slice's rows are read — a few hundred KB, not the whole table.
  const recBuf = Buffer.allocUnsafe(recCount * RECORD_SIZE);
  const recFd = fs.openSync(job.recordsFile, 'r');
  try {
    preadAll(recFd, recBuf, job.recStart * RECORD_SIZE, recBuf.length);
  } finally {
    fs.closeSync(recFd);
  }

  const filters = {
    needle,
    wholeWord: Boolean(job.wholeWord),
    recBuf,
    recCount,
    recIndexBase: job.recStart,
    roleMask: job.roleMask || 0,
    docMask: job.docMask ? Buffer.from(job.docMask) : null,
    since: job.since || 0,
    until: job.until || 0,
    limit: job.limit || 100,
    out,
  };

  const fd = fs.openSync(job.corpusFile, 'r');
  const slab = Buffer.allocUnsafe(SLAB + n + 2);
  try {
    for (let p = job.byteStart; p < job.byteEnd; p += SLAB) {
      const span = Math.min(SLAB, job.byteEnd - p);
      const readStart = Math.max(0, p - 1);                    // 1 byte of left context for whole-word
      const readEnd = Math.min(job.corpusBytes, p + span + n); // needle tail + 1 byte of right context
      const len = preadAll(fd, slab, readStart, readEnd - readStart);
      out.scanned += span;
      const from = p - readStart;
      collectHits({ ...filters, hay: slab.subarray(0, len), hayBase: readStart, from, to: from + span });
    }
  } finally {
    fs.closeSync(fd);
  }
  attachSnippetsFromFile(out.hits, job.textFile, n);
  return out;
}

// Snippets come from corpus.txt (original casing) at offsets found in corpus.lc —
// the two are byte-parallel by construction (fold.js). Only the capped set of
// collected hits is read, so this is a handful of small preads however many
// hundreds of MB were scanned.
function attachSnippetsFromFile(hits, textFile, needleLen) {
  if (!hits.length) return hits;
  const fd = fs.openSync(textFile, 'r');
  const buf = Buffer.allocUnsafe(SNIPPET_RADIUS * 2 + 1024);
  try {
    for (const h of hits) {
      const { start, end } = snippetWindow(h, needleLen);
      const want = Math.min(end - start, buf.length);
      const got = preadAll(fd, buf, start, want);
      fillSnippet(h, buf.subarray(0, got), start, needleLen);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hits;
}

if (parentPort) {
  parentPort.on('message', (job) => {
    try {
      parentPort.postMessage({ id: job.id, ...runScan(job) });
    } catch (err) {
      parentPort.postMessage({ id: job.id, error: true, message: String(err && err.message) });
    }
  });
}
