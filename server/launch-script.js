import fs from 'node:fs';
import path from 'node:path';
import { shellQuote } from './agents/claude.js';
import { DATA_DIR } from './data-dir.js';

// tmux's client→server protocol caps ONE command at MAX_IMSGSIZE (16 KB) and rejects
// anything longer with a bare "command too long" — and a launch command carries the
// whole first prompt inline (`claude … -- <intent>`). So a long brief pasted into the
// dispatch dialog killed the dispatch before any tmux session or mapping entry existed,
// while the identical text pasted into an already-running pane was fine (paste buffers
// travel via a file — see pasteBlock). Well under the cap so the wrapped devcontainer
// form and tmux's own per-message overhead still fit.
export const INLINE_COMMAND_LIMIT = 8192;

const SCRIPT_DIR = path.join(DATA_DIR, 'launch-scripts');
// A script is consumed the instant its pane starts, so anything still around an hour
// later is a leftover from a pane that never ran (or one killed mid-boot). Pruning on
// write keeps the dir from growing one prompt-sized file per oversized launch forever.
const STALE_MS = 60 * 60 * 1000;

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
      /* raced with another prune, or not ours to delete — harmless */
    }
  }
}

// The command string to hand `tmux new-session`. Short commands go inline exactly as
// before; an oversized one moves into a file the pane sources, so only a fixed-length
// path crosses tmux's protocol. Sourcing (`.`) rather than `sh <file>` is deliberate:
// tmux runs the pane command through the user's own shell, so sourcing keeps both the
// interpreter and the process shape identical to the inline form (the agent stays a
// direct child of that one shell, and a `$SHELL`-only PATH still applies).
export function paneCommand(name, cmd, { limit = INLINE_COMMAND_LIMIT, dir = SCRIPT_DIR, now = Date.now() } = {}) {
  if (Buffer.byteLength(cmd, 'utf8') <= limit) return cmd;
  fs.mkdirSync(dir, { recursive: true });
  pruneStale(dir, now);
  // Named for the tmux session (server-generated `cc_`/`cx_` + hex), so a relaunch of
  // the same session overwrites its own script instead of leaving another one behind.
  const file = path.join(dir, `${name}.sh`);
  fs.writeFileSync(file, `${cmd}\n`, { mode: 0o600 });
  return `. ${shellQuote(file)}`;
}
