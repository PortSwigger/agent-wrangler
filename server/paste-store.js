import fs from 'node:fs';
import path from 'node:path';
import { addDirFor, resolvedMemoryBindingFor } from './memory-store.js';
import { isPasteFileName, MAX_ATTACHMENTS_PER_MESSAGE } from './paste-image.js';

// Where a session's pasted images live, and — separately — which form of that
// path the AGENT is handed. Shared by the upload handler and the message handler
// so the two can never disagree about either answer.
//
// Two forms, and the difference is load-bearing:
//  - realDir  is always used for WRITING and for existence checks, so nothing
//             depends on the by-session symlink having been created yet.
//  - agentDir is what goes into a prompt. Claude gets the by-session SYMLINK,
//             because that is literally the string `--add-dir` was given and the
//             form verified against a live pane; handing it the realpath instead
//             would bet that its permission check resolves symlinks the same
//             way, which is untested. Codex gets the real path: it rejects a
//             writable root with a symlinked component (0.149+), so the link is
//             not a path it can use at all.
export function pasteDirs(sessionId, agent) {
  const { memoryDir } = resolvedMemoryBindingFor(sessionId);
  const realDir = path.join(memoryDir, 'pastes');
  const link = addDirFor(sessionId);
  const useLink = agent !== 'codex' && fs.existsSync(link);
  return { realDir, agentDir: useLink ? path.join(link, 'pastes') : realDir };
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
