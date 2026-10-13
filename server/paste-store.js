import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { lastLaunchContext } from './launch-context.js';
import { isPasteFileName, MAX_ATTACHMENTS_PER_MESSAGE } from './paste-image.js';

// Where a session's pasted images live, and — separately — which form of that
// path the AGENT is handed. Shared by the upload handler and the message handler
// so the two can never disagree about either answer.
//
// A paste is only useful if the agent can read the file without a permission
// prompt, and the one directory a launch already grants is whatever the enabled
// extensions put in `launchContext.addDirs` (task-memory's per-session notes
// dir). So pastes go in a `pastes/` subdir of the FIRST such grant, and with no
// grant (no extension is granting a dir) in a core-owned folder the agent can
// still be pointed at — it just prompts before reading it. The grant is the
// last one collected for this session (launch-context.js remembers it), which
// is why boot adopts every active session: the answer is known before a paste.
//
// Two forms, and the difference is load-bearing:
//  - realDir  is always used for WRITING and for existence checks, so nothing
//             depends on a symlink having been created yet.
//  - agentDir is what goes into a prompt. It is the granted path exactly as the
//             launch was given it: for Claude the by-session SYMLINK, because
//             that is literally the string `--add-dir` was given and the form
//             verified against a live pane; handing it the realpath instead
//             would bet that its permission check resolves symlinks the same
//             way, which is untested. Codex's grant is already the real path (it
//             rejects a writable root with a symlinked component, 0.149+).
const PASTES_DIR = path.join(DATA_DIR, 'pastes');
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function pasteDirs(sessionId, _agent) {
  const grant = lastLaunchContext(sessionId).addDirs[0];
  if (grant) {
    let real = grant;
    try { real = fs.realpathSync(grant); } catch { /* not created yet: the granted path is still the one to use */ }
    return { realDir: path.join(real, 'pastes'), agentDir: path.join(grant, 'pastes') };
  }
  const own = path.join(PASTES_DIR, typeof sessionId === 'string' && sessionId !== '.' && sessionId !== '..' && SAFE_SEGMENT.test(sessionId) ? sessionId : '_invalid');
  return { realDir: own, agentDir: own };
}

// Client-supplied names → agent-facing absolute paths. Every name is shape-checked
// (isPasteFileName) and then required to EXIST in this session's own pastes dir, so
// a frame cannot name another session's file, escape the folder, or make the agent
// read something arbitrary. Anything that fails either check is dropped silently
// rather than failing the send: the prose is the part the human cares about, and a
// missing attachment is already visible to them as a reply without it.
export function resolvePasteNames(sessionId, agent, names) {
  if (!Array.isArray(names) || !names.length) return [];
  const { realDir, agentDir } = pasteDirs(sessionId, agent);
  const out = [];
  for (const name of names.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    if (!isPasteFileName(name)) continue;
    try {
      if (!fs.statSync(path.join(realDir, name)).isFile()) continue;
    } catch { continue; }
    out.push(path.join(agentDir, name));
  }
  return out;
}

// Images pasted into the dispatch dialog's intent box. There is no session yet,
// so no pastes dir to write into: they wait here, under a name the server minted,
// until the dispatch that carries those names claims them into the new session's
// own dir (claimStagedPastes). The leading underscore keeps it apart from the
// per-session fallback folders beside it, whose names are UUIDs. Abandoned ones
// are pruned by age like any other paste.
export const STAGED_PASTES_DIR = path.join(PASTES_DIR, '_dispatch-staging');

// Moves each named staged image into `sessionId`'s pastes dir and returns the
// agent-facing paths, in order. The same gate as resolvePasteNames: a name must
// have exactly the minted shape and exist in the staging dir, or it is dropped —
// so a dispatch frame can only ever claim a file this server staged.
export function claimStagedPastes(sessionId, agent, names) {
  if (!Array.isArray(names) || !names.length) return [];
  const { realDir, agentDir } = pasteDirs(sessionId, agent);
  const out = [];
  for (const name of names.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    if (!isPasteFileName(name)) continue;
    const from = path.join(STAGED_PASTES_DIR, name);
    try {
      if (!fs.statSync(from).isFile()) continue;
      fs.mkdirSync(realDir, { recursive: true });
      try { fs.renameSync(from, path.join(realDir, name)); }
      catch (err) {
        // The task-memory grant can sit on another volume than the data dir.
        if (err?.code !== 'EXDEV') throw err;
        fs.copyFileSync(from, path.join(realDir, name));
        fs.rmSync(from, { force: true });
      }
    } catch { continue; }
    out.push(path.join(agentDir, name));
  }
  return out;
}

// Images an extension keeps for itself (host.images, capability `images:keep`).
// A staged image is single-use by design — the first session to claim it takes
// the file — so a job that has to hand the same screenshots to several sessions
// keeps its own copy here first. One folder per extension id, so a name only
// ever resolves against the caller's own files, and nothing prunes it: the
// extension owns the lifecycle and drops what it no longer needs.
const KEPT_DIR = path.join(DATA_DIR, 'ext-images');
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function keptDir(extId) {
  if (typeof extId !== 'string' || !SAFE_SEGMENT.test(extId) || extId === '.' || extId === '..') throw new Error('invalid extension id');
  return path.join(KEPT_DIR, extId);
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Copies a staged image into the extension's own store. Same gate as a claim: the
// name must have the minted shape and exist in the staging dir. The staged file
// is left for its normal prune, so a failed spawn can still be retried from it.
export function keepStagedPaste(extId, name) {
  if (!isPasteFileName(name)) return false;
  const dir = keptDir(extId);
  const from = path.join(STAGED_PASTES_DIR, name);
  if (!isFile(from)) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(from, path.join(dir, name));
  return true;
}

export function hasKeptPaste(extId, name) {
  return isPasteFileName(name) && isFile(path.join(keptDir(extId), name));
}

// The kept image's bytes, for an extension to show back to the human.
export function readKeptPaste(extId, name) {
  if (!hasKeptPaste(extId, name)) return null;
  const bytes = fs.readFileSync(path.join(keptDir(extId), name));
  return { mime: MIME_BY_EXT[path.extname(name).slice(1)], bytes };
}

export function removeKeptPaste(extId, name) {
  if (!isPasteFileName(name)) return false;
  const p = path.join(keptDir(extId), name);
  if (!isFile(p)) return false;
  fs.rmSync(p, { force: true });
  return true;
}

// Does `name` resolve for this extension: kept first, then staged.
export function imageAvailable(extId, name) {
  return hasKeptPaste(extId, name) || (isPasteFileName(name) && isFile(path.join(STAGED_PASTES_DIR, name)));
}

// Puts each named image into `sessionId`'s pastes dir and returns the
// agent-facing paths, in order. A kept name is COPIED (the extension keeps its
// file for the next session); anything else is a staged claim, which moves.
export function claimExtImages(extId, sessionId, agent, names) {
  if (!Array.isArray(names) || !names.length) return [];
  const { realDir, agentDir } = pasteDirs(sessionId, agent);
  const out = [];
  for (const name of names.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    if (!hasKeptPaste(extId, name)) { out.push(...claimStagedPastes(sessionId, agent, [name])); continue; }
    try {
      fs.mkdirSync(realDir, { recursive: true });
      fs.copyFileSync(path.join(keptDir(extId), name), path.join(realDir, name));
    } catch { continue; }
    out.push(path.join(agentDir, name));
  }
  return out;
}
