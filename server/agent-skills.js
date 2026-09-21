import path from 'node:path';
import { taskMemoryEnabled, checklistEnabled } from './config-store.js';
import { getExtensions } from './extensions/index.js';
import { AGENT_SKILLS_PLUGIN_DIR, SKILLS_ROOT, skillsIn } from './skill-catalog.js';

// Re-exported rather than relocated: the adapters and the devcontainer runtime
// ask THIS module where the skills are, and skill-catalog.js exists only
// because the loader needs the same reader and cannot import this one.
export { AGENT_SKILLS_PLUGIN_DIR, SKILLS_ROOT } from './skill-catalog.js';

// The in-repo skills alone — what the one plugin root ships, whatever any
// extension or flag says. Deliberately unfiltered (see activeSkillEntries).
export function skillEntries(skillsRoot = SKILLS_ROOT) {
  return skillsIn(skillsRoot);
}

// The whole catalog: the in-repo skills PLUS the ones each registered extension
// ships under its own `<dir>/skills/<name>/SKILL.md`, tagged with the extension
// id. Derived from the live registry on every call, exactly as the disabled
// lists are, so an install adds a skill and an uninstall takes it away at the
// next launch with nothing to invalidate.
//
// Two rules, and neither is a policy of its own: the IN-REPO skill wins a name
// clash, and an extension may only publish a name its manifest DECLARED. The
// loader refuses both cases outright (validateManifest / stageExtension claim
// skill names the way they claim tool names), so what is left here is the shape
// of that refusal — a quarantined manifest whose directory is still on disk
// must not reach an agent through the back door.
export function allSkillEntries(skillsRoot = SKILLS_ROOT, ext = getExtensions()) {
  const entries = skillEntries(skillsRoot);
  const seen = new Set(entries.map((e) => e.name));
  for (const { id, dir, skills } of ext.list || []) {
    if (!dir || !skills?.length) continue;
    const declared = new Set(skills);
    for (const entry of skillsIn(path.join(dir, 'skills'), id)) {
      if (!declared.has(entry.name) || seen.has(entry.name)) continue;
      seen.add(entry.name);
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// Three things can disable a skill (settings modal → config.json): the
// task-memory and checklist flags (neither feature is an extension yet, so each
// keeps its own flag) and an EXTENSION being off (`ext.disabledSkillIds`, the
// skills declared by every disabled manifest in server/extensions/*). A disabled
// install must never instruct an agent to read AW_TASK_MEMORY, or to keep a
// checklist whose MCP tools aren't registered and whose panel isn't rendered —
// so each drops out of BOTH always-on channels, the mandatory nudge and the
// Codex catalog. Only those: the env/symlink plumbing and the stored checklists
// stay intact, and Claude's --plugin-dir still lists an IN-REPO skill as
// discoverable, which is inert without the nudge — an extension's own skill is
// the one case where this filter reaches the plugin list too, see
// extensionSkillPluginDirs. Both are options (defaulting to live
// config / the boot-loaded extensions) so tests never touch the shared
// config.json or the loader's memo.
//
// `disabledSkills` is the THIRD, per-launch, channel: an enabled extension's
// own `skillsFor` gate (server/extensions/index.js createSkillGate) answering
// for this one session, resolved by session-manager before it calls the adapter
// and threaded down here beside `taskMemory`. Empty for every launch no gate
// speaks for, which is all of them today.
const DISABLEABLE = { 'task-memory': 'taskMemory', checklist: 'checklist' };
function activeSkillEntries(skillsRoot, { taskMemory, checklist, ext, disabledSkills = [] }) {
  const flags = { taskMemory, checklist };
  return allSkillEntries(skillsRoot, ext).filter((e) => {
    const flag = DISABLEABLE[e.name];
    if (flag) return flags[flag];
    if (disabledSkills.includes(e.name)) return false;
    return !ext.disabledSkillIds.includes(e.name);
  });
}

// Discovery (the catalog/plugin listing) isn't reliable for a skill that must be
// followed at every session start regardless of task relevance — an agent only
// reads a SKILL.md when it judges the current task matches, and empirically it
// doesn't always make that call for something as generic as "start of session".
// A skill gets a sidecar WRANGLER.md to have its nudge injected into the
// always-on prompt (Claude's --append-system-prompt, Codex's
// developer_instructions) alongside the on-demand catalog — most skills (links,
// spawn-session) are genuinely optional and carry no nudge.
export function mandatorySkillPrompt(skillsRoot = SKILLS_ROOT, { taskMemory = taskMemoryEnabled(), checklist = checklistEnabled(), ext = getExtensions(), disabledSkills } = {}) {
  const nudges = activeSkillEntries(skillsRoot, { taskMemory, checklist, ext, disabledSkills }).map((e) => e.nudge).filter(Boolean);
  return nudges.join('\n\n');
}

// The always-on pointer block injected into Codex developer_instructions. Codex
// reads a SKILL.md on demand (its workspace-write sandbox allows reads outside
// cwd), mirroring Claude's progressive disclosure: the catalog is cheap and
// always-visible; bodies load only when a task matches a description.
export function codexSkillCatalog(skillsRoot = SKILLS_ROOT, { taskMemory = taskMemoryEnabled(), checklist = checklistEnabled(), ext = getExtensions(), disabledSkills } = {}) {
  const lines = activeSkillEntries(skillsRoot, { taskMemory, checklist, ext, disabledSkills }).map((e) => `- ${e.name} — ${e.description} — ${e.path}`);
  return 'You have wrangler-meta skills available. When a task matches one of the '
    + 'descriptions below, read the corresponding SKILL.md file at the given absolute '
    + 'path for the full instructions before acting. The files are read-only.\n\n'
    + lines.join('\n');
}

// The extra `--plugin-dir` paths a Claude launch carries: one per ACTIVE
// extension-shipped skill. A directory holding a SKILL.md loads as a one-skill
// plugin (the shape ISSUE_TO_PR_SKILL_DIR already uses), which is the only way
// a skill outside the in-repo plugin root reaches the agent at all.
//
// Gated, unlike the in-repo root, and that asymmetry is the point: an in-repo
// skill stays listed when its flag is off because the nudge is what made it
// mandatory, while most extension skills carry no WRANGLER.md at all — so
// discovery IS their only channel and leaving a suppressed one on the command
// line would make `skillsFor` decide nothing for Claude.
export function extensionSkillPluginDirs(skillsRoot = SKILLS_ROOT, { taskMemory = taskMemoryEnabled(), checklist = checklistEnabled(), ext = getExtensions(), disabledSkills } = {}) {
  return activeSkillEntries(skillsRoot, { taskMemory, checklist, ext, disabledSkills })
    .filter((e) => e.extId)
    .map((e) => e.dir);
}

// Every extension-shipped skill dir, UNGATED — the devcontainer runtime's copy
// manifest, built before any launch's gate has answered, so it has to be a
// superset of whatever --plugin-dir ends up naming. A dir copied in and never
// named costs a handful of kilobytes; one named and not copied is a plugin path
// that does not exist inside the container.
export function extensionSkillDirs(ext = getExtensions()) {
  return allSkillEntries(SKILLS_ROOT, ext)
    .filter((e) => e.extId)
    .map((e) => ({ extId: e.extId, name: e.name, dir: e.dir }));
}
