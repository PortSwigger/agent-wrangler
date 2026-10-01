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
