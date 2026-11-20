import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../data-dir.js';
import { decode, msgAt, msgsAt, numAt, strAt, strsAt, timeAt } from './agy-proto.js';

// agy (Antigravity CLI, verified against 1.5.13) keeps each conversation as a
// SQLite file, ~/.gemini/antigravity-cli/conversations/<id>.db. Its `steps`
// table holds one protobuf message per step (agy-proto.js reads them):
//   field 1      step type: 14 user input, 15 model reply, 132 tool call,
//                17 error, 101 a hook's system message (others are skipped)
//   field 4      status (3 is done)
//   field 5      metadata: 1 created at, 4 the tool call ({1 id, 2 name,
//                3 args JSON}), 9 token usage ({2 uncached input, 3 output,
//                5 cache read, 9 thinking}), 11 the model's number
//   field 19     a user input: 2 its text
//   field 20     a model reply: 1 text, 3 thinking, 7 tool calls
//   field 24     an error: 3.1 summary, 3.2 detail
//   field 140    a tool's result: 2.1 its output
// `gen_metadata` maps a model number (1.3) to its id (1.19), and
// `trajectory_metadata_blob` names the conversation (6), its workspaces
// (1[].1, file URLs) and when it began (2).
//
// The board reads everything else (chat view, search, usage, the transcript
// tool) as JSONL by byte offset, so each conversation is mirrored to an
// append-only JSONL file under the board's data dir (syncMirror). A step is
// written once it has settled, again if it changes, and a `rewindTo` record
// marks steps agy later dropped.

export const AGY_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
export const conversationsDir = (agyDir = AGY_DIR) => path.join(agyDir, 'conversations');
export const AGY_DATA = path.join(DATA_DIR, 'agy');
export const MIRROR_DIR = path.join(AGY_DATA, 'transcripts');
// Where the board's SessionStart hook records each launch (agy-hook.js).
export const IDS_DIR = path.join(AGY_DATA, 'ids');
// The folder each board launch adds as a workspace to load the board's plugin
// (agy-config.js). It is never the session's own working directory.
export const BOARD_ROOT = path.join(AGY_DATA, 'root');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isConversationId = (id) => ID_RE.test(String(id || ''));

// node:sqlite is built in from Node 22.5. Loaded on first use with its
// experimental warning silenced; null on an older Node, where agy's
// conversations are simply not read.
let sqlite;
function databaseSync() {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));
  try { sqlite = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { sqlite = null; } finally { process.emitWarning = emit; }
  return sqlite;
}

export function openDb(file) {
  const Db = databaseSync();
  if (!Db || !fs.existsSync(file)) return null;
  try { return new Db(file, { readOnly: true }); } catch { return null; }
}

function withDb(file, fn) {
  const db = openDb(file);
  if (!db) return null;
  try { return fn(db); } catch { return null; } finally { try { db.close(); } catch { /* closed */ } }
}

const realpathOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

const MAX_TOOL_OUTPUT = 4000;
const cap = (s, n = MAX_TOOL_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
const fileUrlPath = (u) => { try { return u.startsWith('file://') ? fileURLToPath(u) : u; } catch { return null; } };
const parseArgs = (s) => { try { return JSON.parse(s); } catch { return s ?? null; } };

// The conversation's own metadata: { id, workspaces, cwd, createdAt }. agy
// keeps its workspaces sorted by path, not in launch order, so `cwd` is only a
// guess: the first one outside the board's data dir (its plugin and task-memory
// folders). conversationCwd knows better.
export function readMeta(db, { boardRoot = BOARD_ROOT } = {}) {
  const row = db.prepare("select data from trajectory_metadata_blob where id = 'main'").get();
  const m = row ? decode(Buffer.from(row.data)) : null;
  if (!m) return null;
  const workspaces = msgsAt(m, 1).map((w) => fileUrlPath(strAt(w, 1) || '')).filter(Boolean);
  const board = path.resolve(boardRoot, '..', '..');
  const under = (dir, p) => { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  // Either side may be a symlinked path (/tmp, /var) or not exist yet.
  const inBoard = (w) => [board, realpathOrSelf(board)].some((b) => [path.resolve(w), realpathOrSelf(path.resolve(w))].some((p) => under(b, p)));
  return {
    id: strAt(m, 6),
    workspaces,
    cwd: workspaces.find((w) => !inBoard(w)) || null,
    createdAt: timeAt(m, 2),
  };
}

function modelNames(db) {
  const names = new Map();
  for (const row of db.prepare('select data from gen_metadata').all()) {
    const g = msgAt(decode(Buffer.from(row.data)), 1);
    const n = numAt(g, 3);
    const id = strAt(g, 19);
    if (n != null && id) names.set(n, id);
  }
  return names;
}

const STEP_USER = 14;
const STEP_REPLY = 15;
const STEP_ERROR = 17;
const STEP_SYSTEM = 101;
const STATUS_DONE = 3;

// One step → its mirror record, or null for a step the board does not show.
export function stepRecord(idx, payload, models = new Map()) {
  const s = decode(payload);
  if (!s) return null;
  const type = numAt(s, 1);
  const meta = msgAt(s, 5);
  const ts = timeAt(meta, 1) || 0;
  const base = { idx, ts, status: numAt(s, 4) };
  if (type === STEP_USER) {
    const text = strAt(s, 19, 2) ?? strAt(s, 19, 3, 1) ?? '';
    return { ...base, kind: 'user', text };
  }
  if (type === STEP_REPLY) {
    const usage = msgAt(meta, 9);
    const n = numAt(meta, 11) ?? numAt(usage, 1);
    const rec = {
      ...base,
      kind: 'assistant',
      text: strAt(s, 20, 1) || '',
      thinking: strAt(s, 20, 3) || '',
      model: (n != null && models.get(n)) || null,
      toolCalls: msgsAt(s, 20, 7).map((c) => ({ id: strAt(c, 1), name: strAt(c, 2), args: parseArgs(strAt(c, 3)) })),
    };
    if (usage) {
      rec.usage = {
        input: numAt(usage, 2) || 0,
        output: numAt(usage, 3) || 0,
        cacheRead: numAt(usage, 5) || 0,
        thinking: numAt(usage, 9) || 0,
      };
    }
    return rec;
  }
  if (type === STEP_ERROR) {
    const err = msgAt(s, 24, 3);
    return { ...base, kind: 'error', text: [strAt(err, 1), strAt(err, 2)].filter(Boolean).join('\n') };
  }
  if (type === STEP_SYSTEM) return null;
  // Every other type that carries a tool call is a tool step. The generic one
  // (132) holds its output at 140.2.1; a dedicated type keeps it elsewhere, so
  // it shows with its name and arguments only.
  const call = msgAt(meta, 4);
  if (!call) return null;
  const output = strAt(s, 140, 2, 1) ?? strsAt(msgAt(s, 140, 2), 1)[0] ?? '';
  return {
    ...base,
    kind: 'tool',
    id: strAt(call, 1),
    name: strAt(call, 2),
    args: parseArgs(strAt(call, 3)),
    output: cap(output),
    ok: numAt(s, 4) === STATUS_DONE,
  };
}

// The whole conversation, read once: { meta, records, lastIdx }. A step still
// in progress at the end is left out until it settles.
export function readConversation(file, opts = {}) {
  return withDb(file, (db) => {
    const meta = readMeta(db, opts);
    const models = modelNames(db);
    const rows = db.prepare('select idx, status, step_payload from steps order by idx').all();
    const lastIdx = rows.length ? rows.at(-1).idx : -1;
    const records = [];
    for (const row of rows) {
      if (!row.step_payload) continue;
      const rec = stepRecord(row.idx, Buffer.from(row.step_payload), models);
      if (!rec) continue;
      const settled = row.status === STATUS_DONE || rec.kind === 'error' || row.idx < lastIdx;
      if (settled) records.push(rec);
    }
    return { meta, records, lastIdx };
  });
}

export function dbPath(id, agyDir = AGY_DIR) {
  return isConversationId(id) ? path.join(conversationsDir(agyDir), `${id}.db`) : null;
}

// A cheap fingerprint of the database and its write-ahead log, so an unchanged
// conversation is not re-read on every poll.
function fingerprint(file) {
  const part = (f) => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; } };
  return `${part(file)}|${part(`${file}-wal`)}`;
}

const hash = (rec) => crypto.createHash('sha1').update(JSON.stringify(rec)).digest('base64');

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Brings a conversation's JSONL mirror up to date and returns its path, or null
// when agy has no such conversation. Only new or changed steps are appended,
// so every byte offset a reader already holds stays valid.
export function syncMirror(id, { agyDir = AGY_DIR, mirrorDir = MIRROR_DIR, boardRoot = BOARD_ROOT, idsDir = IDS_DIR } = {}) {
  const file = dbPath(id, agyDir);
  if (!file || !fs.existsSync(file)) return null;
  const out = path.join(mirrorDir, `${id}.jsonl`);
  const stateFile = path.join(mirrorDir, `${id}.state.json`);
  const print = fingerprint(file);
  let state = fs.existsSync(out) ? readState(stateFile) : null;
  if (state?.print === print) return out;
  const convo = readConversation(file, { boardRoot });
  if (!convo) return fs.existsSync(out) ? out : null;
  const lines = [];
  if (!state) {
    state = { steps: {}, maxIdx: -1 };
    lines.push(JSON.stringify({ agy: 1, conversationId: convo.meta?.id || id, cwd: conversationCwd(id, { agyDir, idsDir, boardRoot }) || convo.meta?.cwd || null, workspaces: convo.meta?.workspaces || [], createdAt: convo.meta?.createdAt || null }));
  }
  if (convo.lastIdx < state.maxIdx) {
    lines.push(JSON.stringify({ rewindTo: convo.lastIdx + 1 }));
    for (const k of Object.keys(state.steps)) if (Number(k) > convo.lastIdx) delete state.steps[k];
  }
  for (const rec of convo.records) {
    const h = hash(rec);
    if (state.steps[rec.idx] === h) continue;
    state.steps[rec.idx] = h;
    lines.push(JSON.stringify(rec));
  }
  state.maxIdx = convo.lastIdx;
  state.print = print;
  fs.mkdirSync(mirrorDir, { recursive: true });
  if (lines.length) fs.appendFileSync(out, `${lines.join('\n')}\n`);
  else if (!fs.existsSync(out)) fs.writeFileSync(out, '');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return out;
}

// Every conversation database, newest first by mtime: [{ id, file, mtimeMs }].
export function allConversations(agyDir = AGY_DIR) {
  let names = [];
  try { names = fs.readdirSync(conversationsDir(agyDir)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.db')) continue;
    const id = name.slice(0, -3);
    if (!isConversationId(id)) continue;
    const file = path.join(conversationsDir(agyDir), name);
    let mtimeMs = 0;
    try { mtimeMs = Math.max(fs.statSync(file).mtimeMs, fs.statSync(`${file}-wal`).mtimeMs); } catch {
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    }
    out.push({ id, file, mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function conversationMeta(id, opts = {}) {
  const file = dbPath(id, opts.agyDir);
  return file ? withDb(file, (db) => readMeta(db, opts)) : null;
}

// Each line of a mirror file, in order. Resolves false when unreadable.
export async function forEachMirrorLine(file, onLine) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) onLine(line);
    return true;
  } catch {
    return false;
  } finally {
    stream?.destroy();
  }
}

// ---- Which conversation a launch is on -------------------------------------

// The board's SessionStart hook (agy-hook.js) writes the conversation id agy
// hands it to <idsDir>/<card id>.json as soon as a conversation starts, so a
// launch never has to guess. Without that record (a hook that failed, a session
// launched before this version) the newest conversation begun after the launch
// in the same folder is taken, the way Codex's rollout is found.

export function recordedConversation(cardId, idsDir = IDS_DIR) {
  if (!cardId) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(idsDir, `${path.basename(String(cardId))}.json`), 'utf8'));
    return isConversationId(rec?.conversationId) ? rec : null;
  } catch {
    return null;
  }
}

// The folder a conversation was started in: the board's own record of its
// launch, else the folder agy's prompt history names for it, else the
// conversation's first workspace outside the board's data dir.
export function conversationCwd(id, { agyDir = AGY_DIR, idsDir = IDS_DIR, boardRoot = BOARD_ROOT } = {}) {
  if (!isConversationId(id)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(idsDir, 'conversations', `${id}.json`), 'utf8'));
    if (typeof rec?.cwd === 'string' && rec.cwd) return rec.cwd;
  } catch { /* not launched by this board */ }
  let fromHistory = null;
  try {
    for (const line of fs.readFileSync(path.join(agyDir, 'history.jsonl'), 'utf8').split('\n')) {
      if (!line.includes(id)) continue;
      try { const h = JSON.parse(line); if (h.conversationId === id && typeof h.workspace === 'string') fromHistory = h.workspace; } catch { /* partial line */ }
    }
  } catch { /* no history */ }
  return fromHistory || conversationMeta(id, { agyDir, boardRoot })?.cwd || null;
}

export function discoverAgyLiveId({ sessionId, cwd, launchedAt = 0, mintedAfter = 0, excludeIds = null, agyDir = AGY_DIR, idsDir = IDS_DIR, boardRoot = BOARD_ROOT } = {}) {
  const recorded = recordedConversation(sessionId, idsDir);
  if (recorded && !(excludeIds?.has(recorded.conversationId)) && (!mintedAfter || (recorded.at || 0) >= mintedAfter - 2000)) {
    return recorded.conversationId;
  }
  if (!cwd) return null;
  const target = realpathOrSelf(cwd);
  const floor = launchedAt ? launchedAt - 2000 : 0;
  for (const c of allConversations(agyDir)) {
    if (c.mtimeMs < floor) break;
    if (excludeIds?.has(c.id)) continue;
    const meta = withDb(c.file, (db) => readMeta(db, { boardRoot }));
    if (!meta) continue;
    if (mintedAfter && meta.createdAt != null && meta.createdAt < mintedAfter - 2000) continue;
    if (meta.workspaces.some((w) => realpathOrSelf(w) === target)) return c.id;
  }
  return null;
}
