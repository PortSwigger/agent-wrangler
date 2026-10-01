// Durable Codex usage ledger: every charged token_count delta from every rollout on
// disk, appended once and kept after the rollout or the card that owned it is gone.
//
// Two files in the data dir:
//  - codex-usage-ledger.jsonl — append-only, the permanent record. Lines are tagged:
//      {t:'e'}      one charged delta (raw tokens, never pre-costed dollars)
//      {t:'meta'}   a rollout's identity and reconciliation snapshot (last one wins)
//      {t:'attach'} a thread seen on a board card, with its task and auth (last wins)
//      {t:'reset'}  a rollout whose bytes changed under the cursor: drop its prior rows
//  - codex-usage-ledger-cursors.json — where each rollout was read up to plus the
//    parser state at that point. Disposable: losing it means a rescan, and entry ids
//    (rollout name + byte offset) make the rescan dedupe instead of double-count.
//
// Rollouts are read incrementally from the last CONFIRMED newline, never the file
// size, so a line Codex is still writing is left for the next pass. The cursor also
// keeps hashes of the file's head and of the bytes just before it; if either changes,
// or the file shrank, the rollout is rescanned from zero behind a reset row.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR as DEFAULT_DATA_DIR } from './data-dir.js';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';
import { newUsageState, parseUsageLine, blankDelta, USAGE_FIELDS } from './agents/codex-usage.js';

export const LEDGER_FILE = 'codex-usage-ledger.jsonl';
export const CURSOR_FILE = 'codex-usage-ledger-cursors.json';
const CURSOR_VERSION = 1;
const HEAD_BYTES = 4096;
const TAIL_BYTES = 256;
const YIELD_EVERY = 2000;

export const DEFAULT_CODEX_ROOTS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.codex', 'archived_sessions'),
];

// `rollout-<ts>-<thread>.jsonl` or `rollout-<ts>-<thread>_<resume>.jsonl`.
export function rolloutIds(name) {
  const m = name.match(/^rollout-.*-([0-9a-fA-F-]{36})(?:_([0-9a-fA-F-]{36}))?\.jsonl$/);
  return m ? { thread: m[1], file: m[2] || m[1] } : null;
}

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function listRollouts(roots) {
  const out = new Map(); // basename -> full path; archived and live never share a name
  async function walk(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (rolloutIds(e.name)) out.set(e.name, full);
    }
  }
  for (const r of roots) await walk(r);
  return out;
}

function addDelta(dest, d) {
  for (const [, k] of USAGE_FIELDS) dest[k] += d[k] || 0;
}

class Ledger {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.entries = new Map(); // rollout name -> Map<id, entry>
    this.metas = new Map(); // rollout name -> meta snapshot
    this.attachments = new Map(); // threadId -> attachment
    this.cursors = new Map(); // rollout name -> cursor
    this.pending = [];
    this.failed = new Set();
  }

  get ledgerPath() { return path.join(this.dataDir, LEDGER_FILE); }
  get cursorPath() { return path.join(this.dataDir, CURSOR_FILE); }

  load() {
    let text = '';
    try { text = fs.readFileSync(this.ledgerPath, 'utf8'); } catch { /* first run */ }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // a torn final line from a crash mid-append
      this.apply(row);
    }
    const disk = readJsonOrLoud(this.cursorPath, CURSOR_FILE);
    if (disk && disk.version === CURSOR_VERSION && disk.cursors) {
      for (const [name, c] of Object.entries(disk.cursors)) this.cursors.set(name, c);
    }
  }

  apply(row) {
    if (row.t === 'e') {
      let m = this.entries.get(row.r);
      if (!m) { m = new Map(); this.entries.set(row.r, m); }
      m.set(row.id, row);
    } else if (row.t === 'meta') {
      this.metas.set(row.r, row);
    } else if (row.t === 'attach') {
      this.attachments.set(row.th, row);
    } else if (row.t === 'reset') {
      this.entries.delete(row.r);
      this.metas.delete(row.r);
    }
  }

  write(row) {
    for (const k of Object.keys(row)) if (row[k] == null) delete row[k];
    this.apply(row);
    this.pending.push(row);
  }

  flush(persist) {
    if (persist && this.pending.length) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      let prefix = '';
      try {
        const st = fs.statSync(this.ledgerPath);
        if (st.size > 0) {
          const fd = fs.openSync(this.ledgerPath, 'r');
          const b = Buffer.alloc(1);
          fs.readSync(fd, b, 0, 1, st.size - 1);
          fs.closeSync(fd);
          if (b[0] !== 0x0a) prefix = '\n'; // never glue a new row onto a torn one
        }
      } catch { /* new file */ }
      fs.appendFileSync(this.ledgerPath, prefix + this.pending.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    this.pending = [];
    if (persist && this.cursorsDirty) {
      writeJsonAtomic(this.cursorPath, { version: CURSOR_VERSION, cursors: Object.fromEntries(this.cursors) });
    }
    this.cursorsDirty = false;
  }

  async syncFile(name, full) {
    let st;
    try { st = await fsp.stat(full); } catch { return; }
    let cursor = this.cursors.get(name);
    if (cursor && cursor.offset === st.size && cursor.size === st.size) return;
    let fh;
    try {
      fh = await fsp.open(full, 'r');
      const headLen = Math.min(HEAD_BYTES, st.size);
      const head = Buffer.alloc(headLen);
      await fh.read(head, 0, headLen, 0);
      const headHash = hash(head);
      if (cursor) {
        let intact = st.size >= cursor.offset && cursor.headLen <= st.size;
        if (intact && cursor.headLen !== headLen && cursor.headLen < HEAD_BYTES) {
          // The head was still short last time; compare the bytes it did have.
          intact = hash(head.subarray(0, cursor.headLen)) === cursor.headHash;
        } else if (intact) {
          intact = headHash === cursor.headHash;
        }
        if (intact && cursor.offset > 0) {
          const n = Math.min(TAIL_BYTES, cursor.offset);
          const tail = Buffer.alloc(n);
          await fh.read(tail, 0, n, cursor.offset - n);
          intact = hash(tail) === cursor.tailHash;
        }
        if (!intact) {
          this.write({ t: 'reset', r: name, at: Date.now() });
          cursor = null;
        }
      }
      // A cursor lost with its file (or never written) but rows already in the
      // ledger: rescan from zero; entry ids make the replay idempotent.
      const state = cursor ? cursor.state : newUsageState();
      let offset = cursor ? cursor.offset : 0;
      const len = st.size - offset;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        let start = 0;
        let n = 0;
        const ids = rolloutIds(name);
        for (;;) {
          const nl = buf.indexOf(0x0a, start);
          if (nl === -1) break; // unterminated tail: an in-progress write, left for next time
          const line = buf.toString('utf8', start, nl);
          const pos = offset + start;
          for (const e of parseUsageLine(state, line, pos)) {
            const { pos: linePos, ...rest } = e;
            this.write({ t: 'e', r: name, id: `${ids.file}:${linePos}`, th: state.meta?.threadId || ids.thread, ...rest });
          }
          start = nl + 1;
          if ((n += 1) % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
        }
        offset += start;
      }
      const tailLen = Math.min(TAIL_BYTES, offset);
      const tail = Buffer.alloc(tailLen);
      if (tailLen) await fh.read(tail, 0, tailLen, offset - tailLen);
      this.cursors.set(name, { size: st.size, offset, headLen, headHash, tailHash: hash(tail), state });
      this.cursorsDirty = true;
      this.writeMetaIfChanged(name, state);
    } catch {
      this.failed.add(name);
    } finally {
      await fh?.close();
    }
  }

  writeMetaIfChanged(name, state) {
    const ids = rolloutIds(name);
    const snap = {
      t: 'meta',
      r: name,
      th: state.meta?.threadId || ids.thread,
      meta: state.meta,
      baselineKind: state.baselineKind,
      inherited: state.inherited,
      baseline: state.baseline,
      final: state.final,
      plan: state.plan,
      checkpoints: state.checkpoints,
      records: state.recordCount ? { count: state.recordCount, sum: state.recordSum } : null,
    };
    for (const k of Object.keys(snap)) if (snap[k] == null) delete snap[k];
    const prev = this.metas.get(name);
    const same = prev && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...snap, at: 0 });
    if (!same) this.write({ ...snap, at: Date.now() });
  }

  attach(threadId, info) {
    const prev = this.attachments.get(threadId);
    const row = { t: 'attach', th: threadId, ...info };
    // Launch history captured earlier is never dropped by a later claim without one.
    if (prev?.launches && !row.launches) row.launches = prev.launches;
    if (prev && prev.cardId === row.cardId && JSON.stringify(prev.launches) === JSON.stringify(row.launches)
      && prev.task?.key === row.task?.key && prev.task?.name === row.task?.name) return;
    this.write({ ...row, at: Date.now() });
  }

  // ---- queries -----------------------------------------------------------
  threadIndex() {
    const threads = new Map(); // threadId -> { rollouts: [name], parent, forkedFrom }
    const aliases = new Map(); // any id (thread or resume-file uuid) -> threadId
    for (const [name, m] of this.metas) {
      const th = m.th;
      let t = threads.get(th);
      if (!t) { t = { id: th, rollouts: [], parent: null, forkedFrom: null }; threads.set(th, t); }
      t.rollouts.push(name);
      t.parent ||= m.meta?.parentThreadId || null;
      t.forkedFrom ||= m.meta?.forkedFromId || null;
      aliases.set(th, th);
      const ids = rolloutIds(name);
      if (ids) aliases.set(ids.file, th);
    }
    const children = new Map();
    for (const t of threads.values()) {
      if (!t.parent) continue;
      const list = children.get(t.parent) || [];
      list.push(t.id);
      children.set(t.parent, list);
    }
    return { threads, aliases, children };
  }

  rolloutEntries(name) {
    return [...(this.entries.get(name)?.values() || [])];
  }

  // Cumulative counter of a thread just before ordinal `ord`, from whichever of its
  // rollouts covers that point. Null when no rollout we hold does.
  cumulativeBefore(thread, ord) {
    let best = null;
    for (const name of thread.rollouts) {
      const m = this.metas.get(name);
      const startOrd = m.meta?.startOrd;
      if (startOrd == null || startOrd >= ord) continue;
      if (!best || startOrd > best.startOrd) best = { name, startOrd, m };
    }
    if (!best) return null;
    const total = { ...(best.m.inherited || blankDelta()) };
    for (const e of this.rolloutEntries(best.name)) {
      if (e.kind === 'baseline' || (e.ord != null && e.ord < ord)) addDelta(total, e.d);
    }
    return total;
  }

  // Health of one thread's own usage. `unattributed` is real usage of the thread whose
  // time and model are unknown: an unexplained starting value, or a resume whose
  // earlier segment the ledger never saw.
  threadHealth(thread) {
    const reasons = [];
    const unattributed = blankDelta();
    for (const name of thread.rollouts) {
      const m = this.metas.get(name);
      if (this.failed.has(name)) reasons.push('unreadable');
      if (m.final) {
        const sum = blankDelta();
        for (const e of this.rolloutEntries(name)) addDelta(sum, e.d);
        const inherited = m.inherited || blankDelta();
        if (USAGE_FIELDS.some(([, k]) => m.final[k] - inherited[k] - sum[k] !== 0)) reasons.push('mismatch');
      }
      if (m.baselineKind === 'unexplained') reasons.push('unexplained-baseline');
      if (m.baselineKind === 'history_base' && m.inherited) {
        const end = m.meta?.historyBase?.endOrdinal;
        const before = end != null ? this.cumulativeBefore(thread, end) : null;
        if (!before) {
          reasons.push('resume-base-missing');
          addDelta(unattributed, m.inherited);
        } else if (USAGE_FIELDS.some(([, k]) => before[k] !== m.inherited[k])) {
          reasons.push('resume-base-mismatch');
        }
      }
    }
    for (const name of thread.rollouts) {
      for (const e of this.rolloutEntries(name)) if (e.ts == null) addDelta(unattributed, e.d);
    }
    const status = reasons.some((r) => r === 'mismatch' || r === 'resume-base-mismatch') ? 'mismatch'
      : reasons.length ? 'incomplete' : 'ok';
    return { status, reasons: [...new Set(reasons)], unattributed };
  }
}

const ledgers = new Map(); // dataDir -> Ledger (the server's long-lived copy)

// Bring the ledger up to date with every rollout under `roots`. `persist: false`
// reads the same way but writes nothing — for a second process (the CLI report)
// that must not race the server's appends.
export async function syncCodexLedger({ dataDir = DEFAULT_DATA_DIR, roots = DEFAULT_CODEX_ROOTS, persist = true } = {}) {
  let ledger = persist ? ledgers.get(dataDir) : null;
  if (!ledger) {
    ledger = new Ledger(dataDir);
    ledger.load();
    if (persist) ledgers.set(dataDir, ledger);
  }
  // One sync at a time per ledger: a cursor's parser state is advanced in place, so
  // two overlapping passes (the daily sweep and a panel scan) must not share it.
  const run = (ledger.syncing || Promise.resolve()).then(async () => {
    ledger.failed = new Set();
    const files = await listRollouts(roots);
    for (const [name, full] of files) await ledger.syncFile(name, full);
    ledger.persist = persist;
    ledger.flush(persist);
    return ledger;
  });
  ledger.syncing = run.catch(() => {});
  return run;
}

// Persist attachments recorded after a sync.
export function flushCodexLedger(ledger) {
  ledger.flush(ledger.persist !== false);
}

export function _resetCodexLedger() { ledgers.clear(); }
