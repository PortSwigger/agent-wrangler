import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from '../data-dir.js';
import { CLAUDE_DIR } from '../claude-paths.js';
import { writeJsonAtomic } from '../atomic-json.js';
import { createPool } from './pool.js';
import { RECORD_SIZE, MAX_CORPUS_BYTES } from './records.js';

// The searchable corpus: every conversation message on disk, extracted once and
// stored as flat bytes.
//
// Why a corpus and not "just grep the transcripts": the transcripts are ~350 MB of
// JSONL, and answering a query from them means JSON.parse'ing all of it — seconds,
// every keystroke. The extracted conversation is a fraction of that size and needs
// no parsing at all, so a query becomes a raw memchr over a few tens of MB. The
// build cost is paid once and then only ever on the tail of files that grew.
//
// Four files in DATA_DIR/search-index:
//   corpus.txt   message texts, NUL-separated, in append order
//   corpus.lc    the same bytes case-folded — byte-parallel, see fold.js
//   records.bin  fixed-width row per message (offset/len/doc/ts/role), see records.js
//   meta.json    the doc table + per-source read cursors
//
// The corpus deliberately OUTLIVES its sources. Claude Code deletes transcripts
// past cleanupPeriodDays (~30), and this index is not rebuilt from scratch when
// that happens: a source that has vanished keeps its records and its doc entry, so
// you can still search conversations whose transcript is long gone. Only a source
// that was *rewritten* (shrank) is tombstoned, because its old bytes are then
// genuinely wrong. This mirrors how usage-scan-cache.json is the long-term spend
// record rather than a cache of something still on disk.
//
// KNOWN GAP (spike): a full rebuild — the Rebuild button, or the automatic one
// COMPACT_RATIO triggers — re-reads only what still exists, so it drops the
// conversations whose transcripts have since been deleted. Making retention
// survive a rebuild means compacting in place (copying live records to a new
// corpus) instead of starting over.

export const INDEX_VERSION = 1;

// Mutable so a test can point the whole index at a tmpdir (_setIndexDir) without
// every function growing a directory argument. Production never calls the setter.
export const PATHS = {};
export function _setIndexDir(dir) {
  PATHS.dir = dir;
  PATHS.text = path.join(dir, 'corpus.txt');
  PATHS.lc = path.join(dir, 'corpus.lc');
  PATHS.records = path.join(dir, 'records.bin');
  PATHS.meta = path.join(dir, 'meta.json');
}
_setIndexDir(path.join(DATA_DIR, 'search-index'));

const CLAUDE_PROJECTS = path.join(CLAUDE_DIR, 'projects');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
// Tombstoned bytes past this share of the corpus make a full rebuild cheaper than
// carrying the dead weight through every scan.
const COMPACT_RATIO = 0.3;

function emptyMeta() {
  return { version: INDEX_VERSION, corpusBytes: 0, recordCount: 0, deadBytes: 0, docs: [], sources: {}, builtAt: 0, updatedAt: 0 };
}

// meta.json carries a row per conversation, so it grows with history — parsing it
// per query (i.e. per keystroke) costs more than the scan does. Cached on the
// file's own mtime+size, which the indexer's atomic rewrite always changes.
let metaCache = null;
export function readMeta() {
  try {
    const st = fs.statSync(PATHS.meta);
    if (metaCache && metaCache.mtimeMs === st.mtimeMs && metaCache.size === st.size) return metaCache.meta;
    const m = JSON.parse(fs.readFileSync(PATHS.meta, 'utf8'));
    if (m && m.version === INDEX_VERSION) {
      metaCache = { mtimeMs: st.mtimeMs, size: st.size, meta: m };
      return m;
    }
  } catch {}
  return emptyMeta();
}

export function _dropMetaCache() { metaCache = null; }

// ── source discovery ───────────────────────────────────────────────────────

const UUID_RE = /^rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/;

async function claudeSources(root) {
  const out = [];
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try { files = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      // Only the top-level per-session transcripts. Sub-agent transcripts
      // (<session>/subagents/**) are artifacts of a session, not a conversation
      // you had — indexing them would surface the same work twice.
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      out.push({ file: path.join(dir, f.name), agent: 'claude', id: f.name.slice(0, -6) });
    }
  }
  return out;
}

async function codexSources(root) {
  const out = [];
  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const m = e.name.match(UUID_RE);
        out.push({ file: full, agent: 'codex', id: m ? m[1] : e.name });
      }
    }
  }
  await walk(root);
  return out;
}

export async function discoverSources({ claudeProjects = CLAUDE_PROJECTS, codexSessions = CODEX_SESSIONS } = {}) {
  const [a, b] = await Promise.all([claudeSources(claudeProjects), codexSources(codexSessions)]);
  const all = [...a, ...b];
  // stat in parallel; a source that vanished between readdir and stat is dropped
  // from this pass but keeps its indexed records (see the note up top).
  await Promise.all(all.map(async (s) => {
    const st = await fsp.stat(s.file).catch(() => null);
    if (st) { s.size = st.size; s.mtimeMs = st.mtimeMs; }
  }));
  return all.filter((s) => typeof s.size === 'number');
}

// ── build / update ─────────────────────────────────────────────────────────

let pool = null;
function parsePool() {
  if (!pool) pool = createPool('./index-worker.js');
  return pool;
}

let inflight = null;

// Bring the index up to date with what's on disk. Coalesces concurrent callers
// onto one run — the Search tab opening, a keystroke, and the periodic sweep all
// arrive at once, and three simultaneous builds would triple the IO for one result.
export function updateIndex(opts = {}) {
  if (inflight) return inflight;
  inflight = runUpdate(opts).finally(() => { inflight = null; });
  return inflight;
}

export function isUpdating() {
  return Boolean(inflight);
}

async function runUpdate({ onProgress, rebuild = false, sources: given = null } = {}) {
  const started = Date.now();
  await fsp.mkdir(PATHS.dir, { recursive: true });
  // A copy, not the cached object: an update mutates `meta` as it appends, and a
  // query running concurrently must keep seeing a consistent pre-update view
  // rather than half-applied counts.
  let meta = structuredClone(readMeta());
  const sources = given || (await discoverSources());

  // Plan the work: what has to be read, and from which byte.
  const jobs = [];
  let tombstoned = 0;
  for (const s of sources) {
    const prev = rebuild ? null : meta.sources[s.file];
    if (!prev) {
      jobs.push({ ...s, from: 0, docIdx: -1 });
    } else if (s.size < prev.consumed) {
      // Rewritten or truncated — the indexed bytes no longer describe this file.
      if (meta.docs[prev.docIdx] && !meta.docs[prev.docIdx].dead) {
        meta.docs[prev.docIdx].dead = true;
        meta.deadBytes += meta.docs[prev.docIdx].bytes || 0;
        tombstoned++;
      }
      jobs.push({ ...s, from: 0, docIdx: -1 });
    } else if (s.size > prev.consumed) {
      jobs.push({ ...s, from: prev.consumed, docIdx: prev.docIdx });
    }
  }

  // Carrying too much tombstoned text through every scan costs more than one
  // rebuild. Recurse once with a clean slate rather than compacting in place.
  if (!rebuild && meta.corpusBytes > 0 && meta.deadBytes / meta.corpusBytes > COMPACT_RATIO) {
    return runUpdate({ onProgress, rebuild: true, sources });
  }

  if (rebuild) {
    await Promise.all([PATHS.text, PATHS.lc, PATHS.records].map((f) => fsp.rm(f, { force: true })));
    meta = emptyMeta();
  }
  if (!jobs.length) {
    meta.updatedAt = Date.now();
    writeJsonAtomic(PATHS.meta, meta);
    metaCache = null; // the writer knows the file changed; don't rely on mtime granularity
    return { ...statsOf(meta), ms: Date.now() - started, filesRead: 0, bytesRead: 0, tombstoned };
  }

  const [textFh, lcFh, recFh] = await Promise.all([
    fsp.open(PATHS.text, 'a'),
    fsp.open(PATHS.lc, 'a'),
    fsp.open(PATHS.records, 'a'),
  ]);
  let filesRead = 0;
  let bytesRead = 0;
  let lastProgress = 0;
  try {
    // Parse in parallel, append serially. `append` is awaited one job at a time,
    // which is what keeps corpus offsets monotonic (records.js depends on it).
    await mapPool(jobs, parsePool(), async (job, res) => {
      filesRead++;
      bytesRead += Math.max(0, res.consumed - job.from);
      let docIdx = job.docIdx;
      if (docIdx < 0) {
        docIdx = meta.docs.length;
        meta.docs.push({ id: job.id, agent: job.agent, file: job.file, cwd: '', title: '', branch: '', firstTs: 0, lastTs: 0, records: 0, bytes: 0 });
      }
      const doc = meta.docs[docIdx];
      if (res.count) {
        const base = meta.corpusBytes;
        if (base + res.text.length > MAX_CORPUS_BYTES) throw new Error('search corpus exceeded 4 GiB — rebuild required');
        const recBuf = Buffer.from(res.records.buffer, res.records.byteOffset, res.records.byteLength);
        for (let i = 0; i < res.count; i++) {
          const at = i * RECORD_SIZE;
          recBuf.writeUInt32LE(recBuf.readUInt32LE(at) + base, at);
          recBuf.writeUInt32LE(docIdx, at + 8);
        }
        await textFh.write(Buffer.from(res.text.buffer, res.text.byteOffset, res.text.byteLength));
        await lcFh.write(Buffer.from(res.lc.buffer, res.lc.byteOffset, res.lc.byteLength));
        await recFh.write(recBuf);
        meta.corpusBytes = base + res.text.length;
        meta.recordCount += res.count;
        doc.records += res.count;
        doc.bytes += res.text.length;
      }
      const m = res.meta || {};
      if (m.cwd) doc.cwd = m.cwd;
      if (m.title) doc.title = m.title;
      if (m.branch) doc.branch = m.branch;
      if (m.id) doc.id = m.id;
      if (m.firstTs && !doc.firstTs) doc.firstTs = m.firstTs;
      if (m.lastTs) doc.lastTs = m.lastTs;
      meta.sources[job.file] = { size: job.size, mtimeMs: job.mtimeMs, consumed: res.consumed, docIdx };
      if (onProgress && Date.now() - lastProgress > 250) {
        lastProgress = Date.now();
        onProgress({ done: filesRead, total: jobs.length, bytesRead, corpusBytes: meta.corpusBytes, records: meta.recordCount });
      }
    });
  } finally {
    await Promise.all([textFh.close(), lcFh.close(), recFh.close()].map((p) => p.catch(() => {})));
  }

  meta.updatedAt = Date.now();
  if (!meta.builtAt) meta.builtAt = meta.updatedAt;
  writeJsonAtomic(PATHS.meta, meta);
  metaCache = null; // the writer knows the file changed; don't rely on mtime granularity
  return { ...statsOf(meta), ms: Date.now() - started, filesRead, bytesRead, tombstoned };
}

// Run `jobs` through the pool at pool-width concurrency, awaiting `onResult`
// serially in completion order.
async function mapPool(jobs, p, onResult) {
  let next = 0;
  let chain = Promise.resolve();
  const width = Math.min(p.size, jobs.length);
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      let res;
      try {
        res = await p.run({ file: job.file, agent: job.agent, from: job.from });
      } catch {
        continue; // an unreadable transcript is skipped, not fatal
      }
      chain = chain.then(() => onResult(job, res));
      await chain;
    }
  });
  await Promise.all(runners);
  await chain;
}

export function statsOf(meta = readMeta()) {
  const live = meta.docs.filter((d) => !d.dead);
  return {
    version: meta.version,
    corpusBytes: meta.corpusBytes,
    deadBytes: meta.deadBytes,
    records: meta.recordCount,
    docs: live.length,
    sources: Object.keys(meta.sources).length,
    builtAt: meta.builtAt,
    updatedAt: meta.updatedAt,
  };
}

export function _resetPool() {
  const p = pool;
  pool = null;
  return p ? p.destroy() : Promise.resolve();
}
