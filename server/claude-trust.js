import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code's "Do you trust this folder?" dialog is suppressed by
// `projects[<path>].hasTrustDialogAccepted === true` in `~/.claude.json`, and
// the entry also covers every descendant of <path> — verified against the
// installed binary (2.1.301): a child of a trusted dir launches straight to the
// prompt, an unrelated dir shows the dialog. So trusting SESSIONS_DIR once
// covers every blank-cwd launch (each lands in a fresh scratch dir beneath it),
// present and future. Never call this for a user's own cwd or a worktree.
//
// `~/.claude.json` is big and rewritten live by running Claude sessions, so this
// writer is conservative: idempotent (no write when already trusted), atomic
// (temp file + rename, mode preserved), re-reads immediately before writing and
// does the check/modify/write with no `await` in between, and skips (logging)
// anything it can't parse rather than overwrite it. Failures never block a launch.

function claudeConfigFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { text: '', data: {} };
    throw e;
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  return { text, data };
}

// Returns true if the file now trusts `dirPath`. `file` and `log` are injectable
// so tests never touch the real config.
export function ensureClaudeTrust(dirPath, { file = claudeConfigFile(), log = console.warn } = {}) {
  if (!dirPath) return false;
  try {
    const { text, data } = readConfig(file);
    if (data.projects?.[dirPath]?.hasTrustDialogAccepted === true) return true;
    if (data.projects != null && (typeof data.projects !== 'object' || Array.isArray(data.projects))) {
      throw new Error('"projects" is not an object');
    }

    data.projects ??= {};
    data.projects[dirPath] = { ...(data.projects[dirPath] || {}), hasTrustDialogAccepted: true };
    const indent = /^\{\n( +)"/.exec(text)?.[1].length ?? 2;
    const out = JSON.stringify(data, null, indent) + (text === '' || text.endsWith('\n') ? '\n' : '');

    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.wrangler-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, out, { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return true;
  } catch (e) {
    log(`[claude-trust] skipped trusting ${dirPath} in ${file}: ${e.message}`);
    return false;
  }
}
