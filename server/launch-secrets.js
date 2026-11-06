import fs from 'node:fs';
import path from 'node:path';
import { shellQuote } from './agents/claude.js';
import { DATA_DIR } from './data-dir.js';

// How a pane launch receives the extensions' `secretEnv` (launch-context.js)
// without the values ever crossing argv, the tmux start command, a log line or
// the graph: the server writes `export NAME='value'` lines to a 0600 file in a
// 0700 directory, and the pane command carries only that file's PATH. The pane
// sources the file and deletes it before the agent starts, so the variables are
// exported by the pane's own shell (a builtin, not a process with an argv) and
// the agent inherits them like any other environment variable.
//
// What this does NOT hide: the agent process's environment itself, which the
// same OS user can read (`ps eww`, /proc/<pid>/environ). That is the point of
// handing the agent the variables; keeping them from the agent is the secrets
// extension's output masking, not this channel.
const SECRET_DIR = path.join(DATA_DIR, 'launch-secrets');
// A file is consumed as soon as its pane starts (or, in a devcontainer, once
// `devcontainer up` has finished, which on a cold build can take many minutes),
// so one still around an hour later belongs to a pane that never got that far.
// Pruned on every write, as launch-script.js does for oversized commands.
const STALE_MS = 60 * 60 * 1000;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function pruneStale(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
    } catch {
      /* raced with another prune — harmless */
    }
  }
}

// Writes the file for one launch and returns its path, or null when there is
// nothing to write. `name` is the server-generated tmux session name, so a
// relaunch of the same session overwrites its own file. Names are re-validated
// here because they are written into shell source; values are single-quoted.
export function writeSecretEnvFile(name, secretEnv, { dir = SECRET_DIR, now = Date.now() } = {}) {
  const entries = Object.entries(secretEnv || {}).filter(([k, v]) => ENV_NAME_RE.test(k) && typeof v === 'string' && !v.includes('\0'));
  if (!entries.length) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  pruneStale(dir, now);
  const file = path.join(dir, `${name}.env`);
  // Removed first so the 0600 mode below applies to a fresh inode, never to a
  // leftover a looser umask or another tool created.
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, entries.map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join(''), { mode: 0o600, flag: 'wx' });
  return file;
}

// `. '<file>' && rm -f '<file>' && ` — the pane-side prefix that loads the
// variables into the pane's shell and deletes the file before the agent runs.
// `file` is the path as the sourcing shell sees it (a container path for a
// devcontainer launch). A sourcing failure stops the launch, and the stale-file
// prune removes what it left.
export function sourceSecretEnv(file) {
  if (!file) return '';
  const q = shellQuote(file);
  return `. ${q} && rm -f ${q} && `;
}
