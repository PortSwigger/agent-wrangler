import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskMemoryEnabled } from './config-store.js';

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

// One entry per agent-skills/skills/<dir>/SKILL.md, sorted by name. `path` is the
// absolute SKILL.md path — what the Codex catalog points at and what makes reads
// cwd-independent. `nudge` is '' unless the skill is mandatory (see
// mandatorySkillPrompt). Dirs lacking a parseable SKILL.md frontmatter are skipped.
export function skillEntries(skillsRoot = SKILLS_ROOT) {
  let dirents;
  try { dirents = fs.readdirSync(skillsRoot, { withFileTypes: true }); } catch { return []; }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const dir = path.join(skillsRoot, d.name);
    const fm = readFrontmatter(path.join(dir, 'SKILL.md'));
    if (fm) entries.push({ name: fm.name, description: fm.description, nudge: readNudge(dir), path: path.join(dir, 'SKILL.md') });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// task-memory is the one user-disableable skill (settings modal →
// config.json `taskMemoryEnabled: false`): a disabled install must never
// instruct an agent to read AW_TASK_MEMORY, so it drops out of BOTH always-on
// channels — the mandatory nudge and the Codex catalog. Only those; the
// env/symlink plumbing stays wired and Claude's --plugin-dir still lists the
// skill as discoverable, which is inert without the nudge. The flag is an
// option (defaulting to live config) so tests never touch the shared config.json.
function activeSkillEntries(skillsRoot, taskMemory) {
  const entries = skillEntries(skillsRoot);
  return taskMemory ? entries : entries.filter((e) => e.name !== 'task-memory');
}

// Discovery (the catalog/plugin listing) isn't reliable for a skill that must be
// followed at every session start regardless of task relevance — an agent only
// reads a SKILL.md when it judges the current task matches, and empirically it
// doesn't always make that call for something as generic as "start of session".
// A skill gets a sidecar WRANGLER.md to have its nudge injected into the
// always-on prompt (Claude's --append-system-prompt, Codex's
// developer_instructions) alongside the on-demand catalog — most skills (links,
// spawn-session) are genuinely optional and carry no nudge.
export function mandatorySkillPrompt(skillsRoot = SKILLS_ROOT, { taskMemory = taskMemoryEnabled() } = {}) {
  const nudges = activeSkillEntries(skillsRoot, taskMemory).map((e) => e.nudge).filter(Boolean);
  return nudges.join('\n\n');
}

// The always-on pointer block injected into Codex developer_instructions. Codex
// reads a SKILL.md on demand (its workspace-write sandbox allows reads outside
// cwd), mirroring Claude's progressive disclosure: the catalog is cheap and
// always-visible; bodies load only when a task matches a description.
export function codexSkillCatalog(skillsRoot = SKILLS_ROOT, { taskMemory = taskMemoryEnabled() } = {}) {
  const lines = activeSkillEntries(skillsRoot, taskMemory).map((e) => `- ${e.name} — ${e.description} — ${e.path}`);
  return 'You have wrangler-meta skills available. When a task matches one of the '
    + 'descriptions below, read the corresponding SKILL.md file at the given absolute '
    + 'path for the full instructions before acting. The files are read-only.\n\n'
    + lines.join('\n');
}
