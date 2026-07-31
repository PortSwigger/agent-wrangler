import os from 'node:os';
import path from 'node:path';

// Base directory for all wrangler state — mappings.json, tasks.json, memory/,
// scratch sessions/, and the per-session symlinks. Overridable via AW_DATA_DIR so
// a dev instance can run against fully isolated state without touching the live
// board's ~/.agent-wrangler. Unset → the legacy default, so existing installs are
// unaffected.
function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export const DATA_DIR = process.env.AW_DATA_DIR
  ? path.resolve(expandTilde(process.env.AW_DATA_DIR))
  : path.join(os.homedir(), '.agent-wrangler');
