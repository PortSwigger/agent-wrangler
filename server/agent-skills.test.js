import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  skillEntries, allSkillEntries, codexSkillCatalog, mandatorySkillPrompt,
  extensionSkillPluginDirs, extensionSkillDirs, SKILLS_ROOT, AGENT_SKILLS_PLUGIN_DIR,
} from './agent-skills.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-skills-'));
  const mk = (name, desc, nudge) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody for ${name}.\n`);
    if (nudge) fs.writeFileSync(path.join(dir, 'WRANGLER.md'), `${nudge}\n`);
  };
  mk('zebra', 'Last alphabetically');
  mk('alpha', 'First alphabetically', 'Always check the alpha thing first.');
  // A dir with no SKILL.md is ignored.
  fs.mkdirSync(path.join(root, 'empty-dir'), { recursive: true });
  return root;
}

test('skillEntries parses frontmatter, sorts by name, skips dirs without SKILL.md', () => {
  const entries = skillEntries(fixture());
  assert.deepEqual(entries.map((e) => e.name), ['alpha', 'zebra']);
  assert.equal(entries[0].description, 'First alphabetically');
  assert.match(entries[0].path, /alpha\/SKILL\.md$/);
  assert.ok(path.isAbsolute(entries[0].path));
});

test('skillEntries reads an optional nudge from a sidecar WRANGLER.md; defaults to empty when absent', () => {
  const entries = skillEntries(fixture());
  assert.equal(entries.find((e) => e.name === 'alpha').nudge, 'Always check the alpha thing first.');
  assert.equal(entries.find((e) => e.name === 'zebra').nudge, '');
});

test('mandatorySkillPrompt joins only the nudges of skills that declare one', () => {
  const root = fixture();
  const prompt = mandatorySkillPrompt(root);
  assert.match(prompt, /Always check the alpha thing first\./);
  assert.doesNotMatch(prompt, /Last alphabetically/);
});

test('mandatorySkillPrompt is empty when no skill declares a nudge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-skills-'));
  fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plain', 'SKILL.md'), '---\nname: plain\ndescription: no nudge here\n---\n\nBody.\n');
  assert.equal(mandatorySkillPrompt(root), '');
});

test('codexSkillCatalog lists each skill as name — description — absolute path', () => {
  const root = fixture();
  const catalog = codexSkillCatalog(root);
  assert.match(catalog, /alpha — First alphabetically — [^\n]*alpha\/SKILL\.md/);
  assert.match(catalog, /zebra — Last alphabetically — [^\n]*zebra\/SKILL\.md/);
  // Always-on preamble instructing on-demand reads.
  assert.match(catalog, /read the corresponding SKILL\.md/i);
});

test('exported install paths are absolute and point at the in-repo agent-skills dir', () => {
  assert.ok(path.isAbsolute(AGENT_SKILLS_PLUGIN_DIR));
  assert.match(AGENT_SKILLS_PLUGIN_DIR, /agent-skills$/);
  assert.match(SKILLS_ROOT, /agent-skills\/skills$/);
});

test('the real agent-skills dir ships its core skills with descriptions', () => {
  const names = skillEntries().map((e) => e.name);
  assert.deepEqual(names, ['adversarial-pr-review', 'advisor', 'archive-to-todo', 'checklist', 'links', 'mail', 'session-activity', 'session-hierarchy', 'spawn-session', 'task-memory']);
  for (const e of skillEntries()) assert.ok(e.description.length > 0, `${e.name} has a description`);
});

test('the archive-to-todo skill is discoverable for session handoffs', () => {
  const entry = skillEntries().find((item) => item.name === 'archive-to-todo');
  assert.ok(entry);
  assert.match(entry.description, /current session/);
  const catalog = codexSkillCatalog(SKILLS_ROOT, { taskMemory: true, checklist: true, ext: { list: [], disabledSkillIds: [] } });
  assert.match(catalog, /- archive-to-todo —/);
  assert.doesNotMatch(catalog, /- park-session —/);
  assert.doesNotMatch(catalog, /- todo —/);
  assert.doesNotMatch(catalog, /- todoify —/);
});

test('task-memory, mail and checklist are mandatory (carry a nudge); links, spawn-session, session-activity, session-hierarchy, and advisor are discovery-only', () => {
  const byName = Object.fromEntries(skillEntries().map((e) => [e.name, e]));
  assert.ok(byName['task-memory'].nudge.length > 0);
  // mail: discovery alone isn't reliable for the standing read-your-mail
  // instruction (CLAUDE.md), so it carries an always-on nudge too, on top of
  // the per-message footer (a separate, per-message control — see mail-format.js).
  assert.ok(byName.mail.nudge.length > 0);
  // checklist: the panel is only useful if agents actually write to it, and a
  // discoverable skill alone doesn't self-invoke — so a MINIMAL pointer rides
  // the always-on prompt and the real guidance stays in the SKILL.md.
  assert.ok(byName.checklist.nudge.length > 0);
  assert.equal(byName.links.nudge, '');
  assert.equal(byName['spawn-session'].nudge, '');
  assert.equal(byName['session-activity'].nudge, '');
  assert.equal(byName['session-hierarchy'].nudge, '');
  assert.equal(byName.advisor.nudge, '');
  assert.match(mandatorySkillPrompt(SKILLS_ROOT, { taskMemory: true }), /AW_TASK_MEMORY/);
  assert.match(mandatorySkillPrompt(SKILLS_ROOT, { taskMemory: true }), /read_mail/);
  // The send-tool disambiguation must ride the always-on nudge, not just the
  // discoverable SKILL.md: it exists for the post-compaction case, where a
  // session's memory of having used mcp send_message is gone and only the
  // per-turn system prompt is left to steer it away from Claude Code's
  // built-in SendMessage (which can't resolve a card id — live incident).
  assert.match(mandatorySkillPrompt(SKILLS_ROOT, { taskMemory: true }), /send_message/);
  assert.match(mandatorySkillPrompt(SKILLS_ROOT, { taskMemory: true }), /built-in `SendMessage`/);
  // The nudge is a POINTER, not the guidance: it must name the tool and the
  // skill, and must say the checklist is separate from the agent's own planner
  // (the one thing an agent would otherwise get wrong without reading further).
  const nudge = mandatorySkillPrompt(SKILLS_ROOT, { checklist: true, taskMemory: true, ext: { disabledSkillIds: [] } });
  assert.match(nudge, /add_checklist_item/);
  assert.match(nudge, /`checklist` skill/);
  assert.match(nudge, /never synced/);
});

test('checklist:false drops the checklist skill from the mandatory nudge and the Codex catalog — nothing else', () => {
  const root = fixture();
  const dir = path.join(root, 'checklist');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: checklist\ndescription: Keep a visible checklist\n---\n\nBody.\n');
  fs.writeFileSync(path.join(dir, 'WRANGLER.md'), 'Use add_checklist_item for visible progress.\n');

  const off = { taskMemory: true, checklist: false, ext: { disabledSkillIds: [] } };
  assert.doesNotMatch(mandatorySkillPrompt(root, off), /add_checklist_item/);
  assert.match(mandatorySkillPrompt(root, off), /alpha thing/); // other nudges survive
  assert.doesNotMatch(codexSkillCatalog(root, off), /checklist/);
  assert.match(codexSkillCatalog(root, off), /alpha/);
  // skillEntries itself stays unfiltered — the plugin dir still ships the skill.
  assert.ok(skillEntries(root).some((e) => e.name === 'checklist'));

  const on = { taskMemory: true, checklist: true, ext: { disabledSkillIds: [] } };
  assert.match(mandatorySkillPrompt(root, on), /add_checklist_item/);
  assert.match(codexSkillCatalog(root, on), /checklist/);
});

// A disabled extension's skill ids (the loader's `disabledSkillIds`) drop from
// both always-on channels; a fake `ext` pins the set rather than whatever this
// developer's config.json says. The id names an IN-REPO skill here — the
// extension-shipped case is at the bottom of this file.
test('a disabled extension\'s skill ids drop from the mandatory nudge and the Codex catalog — nothing else', () => {
  const root = fixture();
  const base = { taskMemory: true, checklist: true };
  const off = { ...base, ext: { disabledSkillIds: ['zebra'] } };
  assert.doesNotMatch(codexSkillCatalog(root, off), /- zebra —/);
  assert.match(codexSkillCatalog(root, off), /- alpha —/);
  assert.match(mandatorySkillPrompt(root, off), /alpha thing/);
  // skillEntries itself stays unfiltered — the plugin dir still ships the skill.
  assert.ok(skillEntries(root).some((e) => e.name === 'zebra'));
  assert.match(codexSkillCatalog(root, { ...base, ext: { disabledSkillIds: [] } }), /- zebra —/);
});

// The per-LAUNCH channel (an enabled extension's own `skillsFor` gate, resolved
// by session-manager and threaded down beside taskMemory). Same two channels as
// the global one, but decided per session rather than per install.
test('disabledSkills drops a skill from this launch only, leaving the install\'s own lists alone', () => {
  const root = fixture();
  const base = { taskMemory: true, checklist: true, ext: { disabledSkillIds: [] } };
  const gated = { ...base, disabledSkills: ['alpha'] };
  assert.doesNotMatch(mandatorySkillPrompt(root, gated), /alpha thing/);
  assert.doesNotMatch(codexSkillCatalog(root, gated), /- alpha —/);
  assert.match(codexSkillCatalog(root, gated), /- zebra —/);
  // The very next launch, with no gate, is unaffected — this is per-session.
  assert.match(mandatorySkillPrompt(root, base), /alpha thing/);
  assert.ok(skillEntries(root).some((e) => e.name === 'alpha'));
});

test('taskMemory:false drops task-memory from the mandatory nudge and the Codex catalog — nothing else', () => {
  const root = fixture();
  const dir = path.join(root, 'task-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: task-memory\ndescription: Read the shared memory file\n---\n\nBody.\n');
  fs.writeFileSync(path.join(dir, 'WRANGLER.md'), 'Read AW_TASK_MEMORY at session start.\n');

  const off = { taskMemory: false };
  assert.doesNotMatch(mandatorySkillPrompt(root, off), /AW_TASK_MEMORY/);
  assert.match(mandatorySkillPrompt(root, off), /alpha thing/); // other nudges survive
  assert.doesNotMatch(codexSkillCatalog(root, off), /task-memory/);
  assert.match(codexSkillCatalog(root, off), /alpha/);
  // skillEntries itself stays unfiltered — the plugin dir still ships the skill.
  assert.ok(skillEntries(root).some((e) => e.name === 'task-memory'));

  const on = { taskMemory: true };
  assert.match(mandatorySkillPrompt(root, on), /AW_TASK_MEMORY/);
  assert.match(codexSkillCatalog(root, on), /task-memory/);
});

// ── Extension-shipped skills ──────────────────────────────────────────────
// An installed extension ships its skills the same way the repo does, under
// its own `<dir>/skills/<name>/SKILL.md`. The fake registry entries below are
// the loader's list rows (id/dir/skills), which is all the catalog reads.

function extFixture(id, name, nudge = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aw-ext-${id}-`));
  const skillDir = path.join(dir, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Shipped by ${id}\n---\n\nBody.\n`);
  if (nudge) fs.writeFileSync(path.join(skillDir, 'WRANGLER.md'), `${nudge}\n`);
  return { row: { id, dir, skills: [name] }, skillDir };
}

const registry = (...rows) => ({ list: rows, disabledSkillIds: [] });
const BOTH_ON = { taskMemory: true, checklist: true };

test('an extension\'s own skills/ joins the catalog, tagged with the extension that ships it', () => {
  const root = fixture();
  const { row, skillDir } = extFixture('jobs', 'job-worker', 'Report every step with job_report.');
  const ext = registry(row);
  const entry = allSkillEntries(root, ext).find((e) => e.name === 'job-worker');
  assert.deepEqual({ extId: entry.extId, dir: entry.dir }, { extId: 'jobs', dir: skillDir });
  assert.match(codexSkillCatalog(root, { ...BOTH_ON, ext }), new RegExp(`- job-worker — Shipped by jobs — ${skillDir}/SKILL\\.md`));
  assert.match(mandatorySkillPrompt(root, { ...BOTH_ON, ext }), /job_report/);
  // Claude meets it as a plugin of its own; the in-repo root is not in this list.
  assert.deepEqual(extensionSkillPluginDirs(root, { ...BOTH_ON, ext }), [skillDir]);
  assert.deepEqual(extensionSkillDirs(ext), [{ extId: 'jobs', name: 'job-worker', dir: skillDir }]);
});

test('a skill the manifest does not declare stays content: no gate can narrow it and no toggle can drop it', () => {
  const root = fixture();
  const { row } = extFixture('jobs', 'job-worker');
  fs.mkdirSync(path.join(row.dir, 'skills', 'stowaway'), { recursive: true });
  fs.writeFileSync(path.join(row.dir, 'skills', 'stowaway', 'SKILL.md'), '---\nname: stowaway\ndescription: Undeclared\n---\n\nBody.\n');
  const names = allSkillEntries(root, registry(row)).map((e) => e.name);
  assert.ok(names.includes('job-worker'));
  assert.ok(!names.includes('stowaway'));
});

test('the per-launch gate decides an extension skill\'s --plugin-dir, not just its nudge', () => {
  const root = fixture();
  const { row, skillDir } = extFixture('jobs', 'job-worker', 'Report every step with job_report.');
  const ext = registry(row);
  const gated = { ...BOTH_ON, ext, disabledSkills: ['job-worker'] };
  assert.deepEqual(extensionSkillPluginDirs(root, gated), [], 'discovery is the only channel most of them have');
  assert.doesNotMatch(codexSkillCatalog(root, gated), /job-worker/);
  assert.doesNotMatch(mandatorySkillPrompt(root, gated), /job_report/);
  // The very next launch, with no gate, sees it again — this is per-session.
  assert.deepEqual(extensionSkillPluginDirs(root, { ...BOTH_ON, ext }), [skillDir]);
});

test('a disabled extension\'s shipped skill drops from every channel', () => {
  const root = fixture();
  const { row } = extFixture('jobs', 'job-worker', 'Report every step with job_report.');
  const off = { ...BOTH_ON, ext: { list: [row], disabledSkillIds: ['job-worker'] } };
  assert.doesNotMatch(codexSkillCatalog(root, off), /job-worker/);
  assert.doesNotMatch(mandatorySkillPrompt(root, off), /job_report/);
  assert.deepEqual(extensionSkillPluginDirs(root, off), []);
});

test('an uninstalled extension is gone from the catalog: the list row IS the registration', () => {
  const root = fixture();
  const { row } = extFixture('jobs', 'job-worker');
  assert.ok(allSkillEntries(root, registry(row)).some((e) => e.name === 'job-worker'));
  // Its directory may well still be on disk until the restart; nothing reads it.
  assert.ok(!allSkillEntries(root, registry()).some((e) => e.name === 'job-worker'));
});

test('an in-repo skill wins a name clash with an extension that ships the same name', () => {
  const root = fixture();
  const { row } = extFixture('jobs', 'alpha');
  const entries = allSkillEntries(root, registry(row)).filter((e) => e.name === 'alpha');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].extId, null, 'the wrangler\'s own copy is the one an agent gets');
  assert.match(entries[0].path, new RegExp(`^${root}/alpha/SKILL\\.md$`));
});

test('two extensions shipping one name resolve first-come, never twice', () => {
  const root = fixture();
  const first = extFixture('jobs', 'job-worker');
  const second = extFixture('other', 'job-worker');
  const entries = allSkillEntries(root, registry(first.row, second.row)).filter((e) => e.name === 'job-worker');
  assert.deepEqual(entries.map((e) => e.extId), ['jobs'], 'the loader refuses the second claim; this is the shape of that');
  assert.notEqual(second.skillDir, first.skillDir);
});
