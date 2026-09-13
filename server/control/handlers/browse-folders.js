import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { expandTilde } from '../../session-manager.js';

const MAX_ENTRIES = 12;

// Trailing slashes are how the client says "I've committed to this folder, show
// me inside it" — so they're meaningful here and must NOT be trimmed before the
// split. `/` itself is the one path that is all slash.
function splitTyped(raw) {
  if (raw.endsWith('/')) return { dir: raw, prefix: '' };
  return { dir: path.dirname(raw), prefix: path.basename(raw) };
}

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

// Could `dispatch`'s _ensureCwd (mkdir -p) actually make this path? Walk up to the
// nearest ancestor that exists and ask whether we may create inside it. One walk
// covers every refusal: a path component that is a FILE exists but isn't a
// directory, and an ancestor we can't write to fails the access check — both of
// which would otherwise surface as an opaque mkdir failure at launch time, after
// the dialog has already closed. Several missing levels are fine; the mkdir is
// recursive.
async function isCreatable(p) {
  for (let dir = p, prev = null; dir !== prev; prev = dir, dir = path.dirname(dir)) {
    let st;
    try { st = await fs.stat(dir); } catch { continue; } // doesn't exist yet — keep walking up
    if (!st.isDirectory()) return false;
    try { await fs.access(dir, fsConstants.W_OK); return true; } catch { return false; }
  }
  return false;
}

// Directory completion for the dispatch dialog's folder field. Answers two
// questions in one round trip: what could this become (entries), and is what's
// typed already a real folder (exists) — plus, when it isn't, whether dispatch
// could create it (creatable). The client turns that pair into a hint or a
// refusal, and gates Launch on the refusal.
// Echoes `path` verbatim so the client can drop a reply that lost the race with
// a later keystroke (the control socket doesn't serialize handlers).
export const browseFoldersHandler = {
  type: 'browse-folders',
  async handler(msg, ctx) {
    const raw = String(msg.path ?? '');
    const reply = { type: 'folder-browse', path: raw, entries: [], exists: null, creatable: null };
    const typed = expandTilde(raw.trim());
    if (!typed) { ctx.reply(reply); return; } // blank is legal (scratch session) — no opinion
    if (!path.isAbsolute(typed)) { ctx.reply({ ...reply, exists: false, creatable: false }); return; }

    const bare = typed.replace(/(?!^)\/+$/, '');
    reply.exists = await isDir(bare);
    // Only meaningful for a folder that isn't there; `null` elsewhere keeps this the
    // same tri-state shape as `exists`, so the client reads one pair, never a
    // boolean that means different things depending on the other field.
    if (!reply.exists) reply.creatable = await isCreatable(bare);
    const { dir, prefix } = splitTyped(typed);
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      ctx.reply(reply); // unreadable/nonexistent parent — nothing to offer
      return;
    }
    const lower = prefix.toLowerCase();
    const matched = names
      // Dotfolders stay out of the way until the user asks for one by typing a dot.
      .filter((e) => (prefix.startsWith('.') || !e.name.startsWith('.')) && e.name.toLowerCase().startsWith(lower))
      .sort((a, b) => a.name.localeCompare(b.name));
    const out = [];
    for (const e of matched) {
      const full = path.join(dir, e.name);
      // isDirectory() is false for a symlink to one, and a symlinked repo folder
      // is a perfectly good cwd — so stat anything that isn't already a dir.
      if (!e.isDirectory() && !(e.isSymbolicLink() && await isDir(full))) continue;
      out.push(full);
      if (out.length >= MAX_ENTRIES) break;
    }
    reply.entries = out;
    ctx.reply(reply);
  },
};
