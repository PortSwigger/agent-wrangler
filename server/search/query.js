import fs from 'node:fs';
import { PATHS, readMeta, statsOf } from './corpus.js';
import { createPool } from './pool.js';
import { foldNeedle } from './fold.js';
import { RECORD_SIZE, ROLE_USER, ROLE_ASSISTANT, recordOffset } from './records.js';
import { collectHits, emptyResult, attachSnippetsFromBuffer } from './scan-core.js';

// Query side. Two paths, picked by corpus size:
//
//   resident  — corpus.lc, corpus.txt and records.bin held in Buffers and scanned
//               on this thread. No IPC, no syscalls, no copies. This is the path
//               real data takes: extracting conversation out of the transcripts
//               shrinks ~350 MB of JSONL to single-digit MB, and a few MB of
//               Buffer.indexOf is well under a millisecond.
//   workers   — past RESIDENT_MAX_BYTES, fan the corpus out across a worker pool
//               that streams it in slabs. Bounded RSS, and it keeps a big scan off
//               the event loop (the board's own rebuild ticks share this thread).
//
// There is no term index in either path, and that is the finding, not a shortcut.
// Buffer.indexOf is native SIMD memchr+memcmp at multiple GB/s, so a scan beats a
// postings lookup until the corpus is orders of magnitude bigger than this one —
// and it supports every query shape (punctuation, code, whitespace, any length)
// for free. The work that mattered was moving JSON parsing out of the query path,
// which corpus.js does once at index time.

const DEFAULT_LIMIT = 120;
// Above this the resident copy stops being a good trade: ~2× this in RSS (raw +
// folded) for a server whose whole design is about giving RAM back.
const RESIDENT_MAX_BYTES = 96 * 1024 * 1024;

let scanPool = null;
function pool() {
  if (!scanPool) scanPool = createPool('./scan-worker.js');
  return scanPool;
}

// The resident copy, invalidated whenever the indexer advances the corpus. Keyed
// on corpusBytes + updatedAt: the corpus is append-only between rebuilds, so a
// changed length means "new bytes at the end", and a rebuild changes both.
let resident = null;
function residentCorpus(meta) {
  if (meta.corpusBytes > RESIDENT_MAX_BYTES) return null;
  if (resident && resident.bytes === meta.corpusBytes && resident.updatedAt === meta.updatedAt) return resident;
  try {
    const next = {
      bytes: meta.corpusBytes,
      updatedAt: meta.updatedAt,
      lc: fs.readFileSync(PATHS.lc),
      text: fs.readFileSync(PATHS.text),
      recs: fs.readFileSync(PATHS.records),
    };
    // A short read means the indexer is mid-append; fall back rather than scan a
    // corpus whose record table describes bytes we don't have.
    if (next.lc.length < meta.corpusBytes || next.recs.length < meta.recordCount * RECORD_SIZE) return null;
    resident = next;
    return resident;
  } catch {
    return null;
  }
}

export function _dropResident() { resident = null; }

// Byte offsets of the chunk boundaries: chunk k covers records [b[k], b[k+1]) and
// therefore bytes [offset(b[k]), offset(b[k+1])). Reading K+1 single rows beats
// loading the whole record table into the parent just to slice it.
function boundaryOffsets(recordsFile, bounds, corpusBytes) {
  const fd = fs.openSync(recordsFile, 'r');
  const row = Buffer.allocUnsafe(RECORD_SIZE);
  try {
    return bounds.map((r) => {
      if (r <= 0) return 0;
      const read = fs.readSync(fd, row, 0, RECORD_SIZE, r * RECORD_SIZE);
      return read === RECORD_SIZE ? recordOffset(row, 0) : corpusBytes;
    });
  } finally {
    fs.closeSync(fd);
  }
}

function roleMaskOf(roles) {
  if (!Array.isArray(roles) || !roles.length) return 0;
  let mask = 0;
  if (roles.includes('user')) mask |= 1 << ROLE_USER;
  if (roles.includes('assistant')) mask |= 1 << ROLE_ASSISTANT;
  // Both selected is the same as no filter — leave the mask at 0 so the worker
  // skips the check entirely on the hot path.
  return mask === ((1 << ROLE_USER) | (1 << ROLE_ASSISTANT)) ? 0 : mask;
}

function docMaskOf(docs, agents) {
  const filterAgents = Array.isArray(agents) && agents.length === 1;
  const mask = Buffer.alloc(docs.length);
  let excluded = false;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const ok = !d.dead && (!filterAgents || agents.includes(d.agent));
    mask[i] = ok ? 1 : 0;
    if (!ok) excluded = true;
  }
  return excluded ? mask : null; // nothing excluded → skip the per-hit check entirely
}

export async function search(opts = {}) {
  const started = process.hrtime.bigint();
  // NUL is the corpus record separator, so it can never appear in a query — and
  // allowing it would let one match span two different messages.
  const raw = String(opts.query || '').replace(/\0/g, '');
  const meta = readMeta();
  const stats = statsOf(meta);
  const empty = { query: raw, matches: 0, shownHits: 0, groups: [], truncated: false, ms: 0, scannedBytes: 0, mode: 'none', index: stats };
  if (!raw || !meta.recordCount) return empty;

  const caseSensitive = Boolean(opts.caseSensitive);
  const needle = caseSensitive ? Buffer.from(raw, 'utf8') : foldNeedle(raw);
  const limit = Math.max(1, Math.min(1000, opts.limit || DEFAULT_LIMIT));
  const filters = {
    needle,
    wholeWord: Boolean(opts.wholeWord),
    roleMask: roleMaskOf(opts.roles),
    docMask: docMaskOf(meta.docs, opts.agents),
    since: opts.since ? Math.floor(opts.since / 1000) : 0,
    until: opts.until ? Math.floor(opts.until / 1000) : 0,
    limit,
  };

  // `mode: 'workers'` is a test seam: the two paths must return identical
  // results, and real data never grows big enough here to exercise the fan-out.
  const r = opts.mode === 'workers' ? null : residentCorpus(meta);
  const res = r ? scanResident(r, meta, filters, caseSensitive) : await scanWorkers(meta, filters, caseSensitive);

  return {
    ...shape(res.out, meta, limit),
    query: raw,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    scannedBytes: res.out.scanned,
    mode: res.mode,
    workers: res.workers || 0,
    index: stats,
  };
}

function scanResident(r, meta, filters, caseSensitive) {
  const hay = caseSensitive ? r.text : r.lc;
  const out = emptyResult();
  collectHits({
    ...filters,
    hay,
    hayBase: 0,
    from: 0,
    to: meta.corpusBytes,
    recBuf: r.recs,
    recCount: meta.recordCount,
    recIndexBase: 0,
    out,
  });
  out.scanned = meta.corpusBytes;
  attachSnippetsFromBuffer(out.hits, r.text, filters.needle.length);
  return { out, mode: 'resident' };
}

async function scanWorkers(meta, filters, caseSensitive) {
  const p = pool();
  // Don't split into more chunks than there is work for — spinning up 6 workers
  // for 5k records costs more in IPC than it saves in scanning.
  const chunks = Math.min(p.size, Math.max(1, Math.ceil(meta.recordCount / 20000)));
  const bounds = [];
  for (let k = 0; k <= chunks; k++) bounds.push(Math.round((meta.recordCount * k) / chunks));
  const offsets = boundaryOffsets(PATHS.records, bounds, meta.corpusBytes);
  offsets[chunks] = meta.corpusBytes;

  const base = {
    needle: filters.needle.toString('base64'),
    corpusFile: caseSensitive ? PATHS.text : PATHS.lc,
    textFile: PATHS.text,
    recordsFile: PATHS.records,
    corpusBytes: meta.corpusBytes,
    wholeWord: filters.wholeWord,
    roleMask: filters.roleMask,
    docMask: filters.docMask,
    since: filters.since,
    until: filters.until,
    // Each worker collects up to the full cap; the parent sorts the union by
    // recency and keeps the best `limit`. Counts stay exact either way — only
    // which hits get a snippet is affected.
    limit: filters.limit,
  };

  const parts = await Promise.all(
    Array.from({ length: chunks }, (_, k) =>
      p.run({ ...base, recStart: bounds[k], recEnd: bounds[k + 1], byteStart: offsets[k], byteEnd: offsets[k + 1] })
    )
  );
  const out = emptyResult();
  for (const part of parts) {
    out.matches += part.matches;
    out.scanned += part.scanned;
    out.hits.push(...part.hits);
    for (const [k, v] of Object.entries(part.perDoc || {})) out.perDoc[k] = (out.perDoc[k] || 0) + v;
  }
  return { out, mode: 'workers', workers: chunks };
}

// Merge raw hits into the per-conversation shape the UI renders.
function shape(out, meta, limit) {
  // Most recent first: a conversation search is nearly always "where did I say
  // that recently", and corpus order would lead with whatever file the indexer
  // happened to walk first.
  out.hits.sort((a, b) => b.tsSec - a.tsSec);
  const truncated = out.hits.length > limit;
  const shown = out.hits.slice(0, limit);

  const byDoc = new Map();
  for (const h of shown) {
    let g = byDoc.get(h.docIdx);
    if (!g) {
      const d = meta.docs[h.docIdx] || {};
      g = {
        docIdx: h.docIdx,
        sessionId: d.id || '',
        agent: d.agent || 'claude',
        cwd: d.cwd || '',
        title: d.title || '',
        branch: d.branch || '',
        lastTs: (d.lastTs || 0) * 1000,
        matches: out.perDoc[h.docIdx] || 0,
        hits: [],
      };
      byDoc.set(h.docIdx, g);
    }
    g.hits.push({
      ts: h.tsSec * 1000,
      role: h.role === ROLE_USER ? 'user' : 'assistant',
      snippet: h.snippet || '',
      hitStart: h.hitStart || 0,
      hitChars: h.hitChars || 0,
      headTrimmed: Boolean(h.headTrimmed),
      tailTrimmed: Boolean(h.tailTrimmed),
    });
  }
  const groups = [...byDoc.values()].sort((a, b) => (b.hits[0]?.ts || 0) - (a.hits[0]?.ts || 0));
  return { matches: out.matches, shownHits: shown.length, groups, truncated };
}

export function _resetQueryPool() {
  const p = scanPool;
  scanPool = null;
  resident = null;
  return p ? p.destroy() : Promise.resolve();
}
