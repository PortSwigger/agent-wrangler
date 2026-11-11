import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR } from '../data-dir.js';

// Where Gemini CLI keeps its conversations (verified against 0.66):
//   <home>/.gemini/tmp/<slug>/chats/session-<YYYY-MM-DDTHH-MM>-<id[0:8]>.jsonl
// <home> is GEMINI_CLI_HOME when set, else the user's home. <slug> is a short
// per-project name recorded in <home>/.gemini/projects.json as
// { projects: { "<abs cwd>": "<slug>" } }. A conversation is append-only JSONL:
// a metadata line ({ sessionId, projectHash, startTime, kind }), then message
// records ({ id, timestamp, type, content, … }, re-appended under the same id
// when tokens or tool calls are added; the last copy wins), `$set` metadata
// updates, `$patch` edits and `$rewindTo` markers.

// The Gemini dir a process sees: <GEMINI_CLI_HOME or home>/.gemini.
export function geminiHome(env = process.env) {
  return path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

// The Gemini home the board launches its sessions with (gemini-config.js).
export const BOARD_GEMINI_HOME = path.join(DATA_DIR, 'gemini', 'home');

// The user's own Gemini dir: what this process sees, unless that is the
// board's home (a server started from inside a board Gemini session).
export function userGeminiDir(env = process.env) {
  const dir = geminiHome(env);
  return path.resolve(dir) === path.resolve(BOARD_GEMINI_HOME, '.gemini') ? path.join(os.homedir(), '.gemini') : dir;
}

// Where conversations are looked for: the board's sessions first, then the
// user's own (search and the adopt picker read both).
export const GEMINI_TMP = [path.join(BOARD_GEMINI_HOME, '.gemini', 'tmp'), path.join(userGeminiDir(), 'tmp')];
const rootsOf = (root) => [...new Set(Array.isArray(root) ? root : [root])];

const SESSION_FILE_RE = /^session-.+-([A-Za-z0-9_-]{1,8})\.jsonl?$/;

// The 8-character id suffix Gemini names a conversation file with.
export const shortId = (id) => String(id || '').slice(0, 8);

// The metadata on a conversation's first line, or null.
export function readHeadSync(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const head = JSON.parse(line);
    return head && typeof head.sessionId === 'string' ? head : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Every top-level conversation file under the tmp root, newest first by mtime.
// Subagent conversations live one level deeper (chats/<parent>/<id>.jsonl) and
// are deliberately left out: they belong to a session, they are not one.
export async function allConversationFiles(root = GEMINI_TMP) {
  const out = [];
  for (const r of rootsOf(root)) {
    let projects;
    try { projects = await fsp.readdir(r, { withFileTypes: true }); } catch { continue; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const chats = path.join(r, p.name, 'chats');
      let names;
      try { names = await fsp.readdir(chats); } catch { continue; }
      for (const name of names) {
        if (!SESSION_FILE_RE.test(name)) continue;
        const full = path.join(chats, name);
        try { out.push({ file: full, slug: p.name, mtimeMs: (await fsp.stat(full)).mtimeMs }); } catch { /* raced a delete */ }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function candidatesSync(id, root) {
  const suffix = `-${shortId(id)}.jsonl`;
  const out = [];
  for (const r of rootsOf(root)) {
    let projects;
    try { projects = fs.readdirSync(r, { withFileTypes: true }); } catch { continue; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const chats = path.join(r, p.name, 'chats');
      let names;
      try { names = fs.readdirSync(chats); } catch { continue; }
      for (const name of names) {
        if (name.startsWith('session-') && name.endsWith(suffix)) out.push(path.join(chats, name));
      }
    }
  }
  return out;
}

// The conversation file for a session id: the newest file whose name carries the
// id's short form and whose first line names the full id. Null when none does.
export function findConversationSync(id, root = GEMINI_TMP) {
  if (!id) return null;
  let best = null;
  for (const file of candidatesSync(id, root)) {
    if (readHeadSync(file)?.sessionId !== id) continue;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file || null;
}

export async function findConversation(id, root = GEMINI_TMP) {
  return findConversationSync(id, root);
}

// projects.json as { cwd → slug }, empty when unreadable.
export function readProjects(home = geminiHome()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'projects.json'), 'utf8'));
    return parsed?.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
  } catch {
    return {};
  }
}

// The working directory a conversation file was recorded for, from its
// project's slug (the reverse of the projects.json beside its tmp/). Null when
// the slug is unknown.
export function cwdForConversation(file, home = path.dirname(path.dirname(path.dirname(path.dirname(file))))) {
  const slug = path.basename(path.dirname(path.dirname(file)));
  const hit = Object.entries(readProjects(home)).find(([, s]) => s === slug);
  return hit ? hit[0] : null;
}

// Each line of a conversation file, in order. Resolves false when unreadable.
export async function forEachConversationLine(file, onLine) {
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

// The search corpus's sources: one per top-level conversation.
export async function geminiSources(root = GEMINI_TMP) {
  const out = [];
  for (const { file } of await allConversationFiles(root)) {
    const id = readHeadSync(file)?.sessionId;
    if (id) out.push({ file, agent: 'gemini', id });
  }
  return out;
}
