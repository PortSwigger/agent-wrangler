import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reading a skill off disk. It lives apart from agent-skills.js because BOTH
// that module and server/extensions/index.js need it — the catalog to publish a
// skill an extension ships, the loader to resolve a manifest's declared `skills`
// names at load time — and agent-skills.js already imports the loader for
// `getExtensions()`, so the loader cannot import it back. A second copy of "what
// a SKILL.md is" inside the loader is the thing that would drift.
//
// A LEAF: node:fs / node:path / node:url only, so server/extensions/** may
// import it without breaching its own leaf rule.

// The wrangler-meta skills ship in-repo under agent-skills/. Resolved from this
// module's own path (server/ → repo root → agent-skills), so the running install
// — worktree or merged main checkout — points at its own bundled copy, and the
// paths survive an arbitrary or changing session cwd. AGENT_SKILLS_PLUGIN_DIR is
// the plugin root Claude loads via --plugin-dir; SKILLS_ROOT holds the skill dirs
// the Codex catalog reads.
export const AGENT_SKILLS_PLUGIN_DIR = fileURLToPath(new URL('../agent-skills', import.meta.url));
export const SKILLS_ROOT = path.join(AGENT_SKILLS_PLUGIN_DIR, 'skills');

// Minimal frontmatter read: the leading --- block's `name` and `description`
// lines. Avoids a YAML dependency — the only fields we need are simple scalars on
// their own line. Returns null when there is no parseable name. Deliberately
// reads only the two fields Anthropic's skill format defines — SKILL.md stays a
// portable, standard skill definition; wrangler-specific config never lives here
// (see readNudge below).
function readFrontmatter(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const block = m[1];
  const field = (key) => {
    const fm = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return fm ? fm[1].trim() : '';
  };
  const name = field('name');
  if (!name) return null;
  return { name, description: field('description') };
}

// Wrangler-specific per-skill config lives in a sidecar WRANGLER.md next to
// SKILL.md, never inside the skill's own frontmatter — "must be force-injected
// at launch" is a wrangler orchestration decision, not skill content, and a
// sidecar keeps it colocated with the skill it modifies (renaming a skill dir
// can't drift it out of sync, unlike a name-keyed registry elsewhere). Its raw
// (trimmed) content IS the nudge text; the file's mere presence marks a skill
// mandatory. Absence (the common case) means '' — discovery-only.
function readNudge(skillDir) {
  try { return fs.readFileSync(path.join(skillDir, 'WRANGLER.md'), 'utf8').trim(); } catch { return ''; }
}

// One skill, or null when `dir` holds no SKILL.md with a parseable frontmatter
// name. `path` is the absolute SKILL.md — what the Codex catalog points at and
// what makes reads cwd-independent; `dir` is what Claude loads as a plugin.
// `extId` names the extension that SHIPS the skill and is null for the in-repo
// ones, which is the whole difference a launch has to act on: an in-repo skill
// is already inside the one plugin root, an extension's is not.
export function skillAt(dir, extId = null) {
  const file = path.join(dir, 'SKILL.md');
  const fm = readFrontmatter(file);
  if (!fm) return null;
  return { name: fm.name, description: fm.description, nudge: readNudge(dir), path: file, dir, extId };
}

// One entry per <root>/<dir>/SKILL.md, sorted by name. Dirs lacking a parseable
// SKILL.md frontmatter are skipped, and an unreadable root is simply empty —
// an extension that ships no skills/ directory is the ordinary case.
export function skillsIn(root, extId = null) {
  let dirents;
  try { dirents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const entry = skillAt(path.join(root, d.name), extId);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
