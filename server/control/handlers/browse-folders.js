import fs from 'node:fs/promises';
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

// Directory completion for the dispatch dialog's folder field. Answers two
// questions in one round trip: what could this become (entries), and is what's
// typed already a real folder (exists) — the client gates Launch on the latter.
// Echoes `path` verbatim so the client can drop a reply that lost the race with
// a later keystroke (the control socket doesn't serialize handlers).
export const browseFoldersHandler = {
  type: 'browse-folders',
  async handler(msg, ctx) {
    const raw = String(msg.path ?? '');
    const reply = { type: 'folder-browse', path: raw, entries: [], exists: null };
    const typed = expandTilde(raw.trim());
    if (!typed) { ctx.reply(reply); return; } // blank is legal (scratch session) — no opinion
    if (!path.isAbsolute(typed)) { ctx.reply({ ...reply, exists: false }); return; }

    reply.exists = await isDir(typed.replace(/(?!^)\/+$/, ''));
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
