import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Codex's interactive "do you trust this directory" dialog is NOT suppressible
// via a `-c` CLI override — verified against the installed binary (0.148.0)
// under a real git worktree: `-c projects."<cwd>".trust_level="trusted"` is
// silently ignored by the dialog, whether keyed on the worktree path or its
// main-checkout root. Only an entry already PERSISTED in `~/.codex/config.toml`
// at process start suppresses it. For a linked worktree, Codex resolves trust
// to the worktree's MAIN checkout (git commondir) — trusting that root (not the
// worktree path) covers every worktree of the repo, present and future, in one
// write. That's a broader grant than the old per-invocation override pretended
// to make; it's the deliberate tradeoff of making the dialog actually go away.
//
// TOML forbids two `[table]` headers for the same key — verified: a duplicate
// `[projects."X"]` block makes Codex refuse to load config.toml AT ALL, which
// breaks every Codex session on the machine (wrangler-launched or not, past or
// future) until a human edits the file by hand. So this writer is deliberately
// paranoid: idempotent (never touches the file if the key is already trusted,
// checked synchronously with no `await` between check and write — same
// technique as mailbox-store.js's synchronous mutators, so two calls from THIS
// process can never interleave), append-only (never rewrites existing bytes, so
// it can't silently clobber a concurrent writer's unrelated change), and it
// re-scans the whole file after writing to catch a lost race against some OTHER
// process (a manual `codex` run accepting its own prompt at the same path, at
// the same instant). If that happens, it surgically removes exactly the bytes
// it just appended (never another writer's content), leaves a forensic copy of
// the broken file for debugging, and throws — so the launch fails loudly and
// the config.toml already on disk stays valid. A retry is expected to succeed;
// the race window is a handful of milliseconds.

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function configPath() {
  return path.join(codexHome(), 'config.toml');
}

// TOML basic-string escaping for a `projects."<path>"` key (matches the escaping
// codex itself uses when persisting an interactively-accepted trust entry).
function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function headerFor(dirPath) {
  return `[projects.${tomlString(dirPath)}]`;
}

// Single-bracket table headers only, one per line — `[[..]]` array-of-tables
// (used elsewhere in codex's config, e.g. mcp_servers) are a different TOML
// construct and never how `projects.*` entries are written, so excluding them
// here can't mask a real collision on a `projects.*` key.
function tableHeaders(text) {
  return (text.match(/^\[[^\[\]].*\]$/gm) || []).map((l) => l.trim());
}

// Exported for tests only, so a test asserting "no duplicate survives" reuses
// this exact scanner instead of a second copy that could drift from it.
export function hasDuplicateHeader(text) {
  const seen = new Set();
  for (const h of tableHeaders(text)) {
    if (seen.has(h)) return true;
    seen.add(h);
  }
  return false;
}

// Ensure `dirPath` is trusted in Codex's persisted config so a non-interactive
// launch there never hits the trust dialog. No-op if already trusted (the
// common case after the first launch in a repo). Throws if a concurrent writer
// raced this call to the same path — see file header; callers should surface
// that as a launch failure, not swallow it.
export function ensureCodexTrust(dirPath) {
  if (!dirPath) return;
  const file = configPath();
  const header = headerFor(dirPath);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (text.includes(header)) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const needsBlankLine = text.length > 0 && !text.endsWith('\n\n');
  const block = `${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}${needsBlankLine ? '\n' : ''}${header}\ntrust_level = "trusted"\n`;
  fs.appendFileSync(file, block);

  const after = fs.readFileSync(file, 'utf8');
  if (!hasDuplicateHeader(after)) return;

  const forensic = `${file}.wrangler-broken-${Date.now()}`;
  fs.writeFileSync(forensic, after);

  // Was the file already unloadable BEFORE this call touched it? Then this
  // isn't a race we caused, and undoing our own (non-colliding) block can't
  // fix it — say so plainly instead of claiming a resolution that didn't
  // happen. Leaving our block in place does no additional harm (config.toml
  // was already broken) and saves a step once a human fixes the real header.
  if (hasDuplicateHeader(text)) {
    throw new Error(
      `${file} already had a duplicate [table] header — unrelated to ${dirPath} — BEFORE this launch `
      + `touched it; Codex was already refusing to load this config.toml. This launch did not cause it `
      + `and appending a trust entry can't fix it. A human needs to edit ${file} by hand to remove the `
      + `duplicate (a copy of the current, still-broken state is at ${forensic}).`
    );
  }

  // Our own append collided with some other concurrent writer targeting this
  // exact path (e.g. a manual `codex` run accepting its own prompt at the same
  // instant) — `text` had no duplicate, so the second copy is new. Remove
  // exactly one copy of the bytes we just added (a plain, non-global replace):
  // since the two copies are byte-identical, this leaves the file validly
  // trusted for `dirPath` either way — but throw and force a retry regardless,
  // rather than assume that's the only thing that changed underneath us.
  fs.writeFileSync(file, after.replace(block, ''));
  throw new Error(
    `Refused to trust ${dirPath} for Codex: a concurrent write to ${file} raced this one and would `
    + `have left a duplicate [projects] entry (Codex refuses to load config.toml with one present). `
    + `Removed the copy this call added (a copy of the pre-removal, colliding state is at ${forensic}). `
    + `Retry the launch — it will very likely already see ${dirPath} as trusted.`
  );
}
