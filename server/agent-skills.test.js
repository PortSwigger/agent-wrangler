import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillEntries, codexSkillCatalog, mandatorySkillPrompt, SKILLS_ROOT, AGENT_SKILLS_PLUGIN_DIR } from './agent-skills.js';

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

test('the real agent-skills dir ships task-memory, links, spawn-session, session-activity, and advisor with descriptions', () => {
  const names = skillEntries().map((e) => e.name);
  assert.deepEqual(names, ['advisor', 'links', 'session-activity', 'spawn-session', 'task-memory']);
  for (const e of skillEntries()) assert.ok(e.description.length > 0, `${e.name} has a description`);
});

test('task-memory is mandatory (carries a nudge); links, spawn-session, session-activity, and advisor are discovery-only', () => {
  const byName = Object.fromEntries(skillEntries().map((e) => [e.name, e]));
  assert.ok(byName['task-memory'].nudge.length > 0);
  assert.equal(byName.links.nudge, '');
  assert.equal(byName['spawn-session'].nudge, '');
  assert.equal(byName['session-activity'].nudge, '');
  assert.equal(byName.advisor.nudge, '');
  assert.match(mandatorySkillPrompt(SKILLS_ROOT, { taskMemory: true }), /AW_TASK_MEMORY/);
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
