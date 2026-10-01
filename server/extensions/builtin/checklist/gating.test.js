import { test } from 'node:test';
import assert from 'node:assert/strict';
import manifest from './index.js';
import { loadExtensions, extensionsForGraph } from '../../index.js';
import { activeTools } from '../../../mcp/tools/index.js';
import { allowedToolsArg, allowedToolName } from '../../../mcp/client-config.js';
import {
  mandatorySkillPrompt, codexSkillCatalog, extensionSkillPluginDirs, allSkillEntries, SKILLS_ROOT,
} from '../../../agent-skills.js';

const TOOL_NAMES = ['add_checklist_item', 'update_checklist_item', 'remove_checklist_item', 'list_checklist'];
const on = () => loadExtensions({ cfg: {}, builtin: [manifest] });
const off = () => loadExtensions({ cfg: { extensions: { checklist: false } }, builtin: [manifest] });
const opts = (ext) => ({ taskMemory: false, ext });

// The two-place rule for core tools (TOOLS + ALLOWED_TOOLS) does not apply to an
// extension's: the loader registers and grants from one list. These pin that for
// the real manifest, in both states of its `extensions.checklist` switch.
test('enabled: the four tools are registered and granted to launched sessions', () => {
  const ext = on();
  const registered = activeTools({ ext }).map((t) => t.name);
  const granted = allowedToolsArg({ ext }).split(',');
  for (const name of TOOL_NAMES) {
    assert.ok(registered.includes(name), `${name} registered`);
    assert.ok(granted.includes(allowedToolName(name)), `${name} granted`);
  }
});

test('disabled: the four tools leave the MCP listing and the launch grant, nothing else does', () => {
  const ext = off();
  const registered = activeTools({ ext }).map((t) => t.name);
  const granted = allowedToolsArg({ ext }).split(',');
  for (const name of TOOL_NAMES) {
    assert.ok(!registered.includes(name), `${name} must not be registered`);
    assert.ok(!granted.includes(allowedToolName(name)), `${name} must not be granted`);
  }
  assert.ok(registered.includes('list_sessions'));
  assert.ok(granted.includes(allowedToolName('read_mail')));
});

test('enabled: the checklist skill is shipped, nudged, catalogued and handed to Claude as a plugin dir', () => {
  const ext = on();
  assert.ok(allSkillEntries(SKILLS_ROOT, ext).some((e) => e.name === 'checklist' && e.extId === 'checklist'));
  assert.match(mandatorySkillPrompt(SKILLS_ROOT, opts(ext)), /add_checklist_item/);
  assert.match(codexSkillCatalog(SKILLS_ROOT, opts(ext)), /- checklist —/);
  assert.equal(extensionSkillPluginDirs(SKILLS_ROOT, opts(ext)).filter((d) => d.endsWith('/skills/checklist')).length, 1);
});

test('disabled: the checklist skill drops from the nudge, the Codex catalog and the plugin dirs', () => {
  const ext = off();
  assert.doesNotMatch(mandatorySkillPrompt(SKILLS_ROOT, opts(ext)), /add_checklist_item/);
  assert.doesNotMatch(codexSkillCatalog(SKILLS_ROOT, opts(ext)), /- checklist —/);
  assert.deepEqual(extensionSkillPluginDirs(SKILLS_ROOT, opts(ext)).filter((d) => d.endsWith('/skills/checklist')), []);
  // Other in-repo skills are untouched.
  assert.match(codexSkillCatalog(SKILLS_ROOT, opts(ext)), /- mail —/);
});

test('the board sees the extension as a normal toggleable builtin, not an install needing consent', () => {
  const [row] = extensionsForGraph(on().list, (id, d) => d);
  assert.equal(row.id, 'checklist');
  assert.equal(row.external, false);
  assert.equal(row.enabled, true);
  assert.equal(row.defaultEnabled, true);
  assert.deepEqual(row.handlerTypes.sort(), ['checklist-add', 'checklist-remove', 'checklist-reorder', 'checklist-update']);
  const [offRow] = extensionsForGraph(off().list, () => false);
  assert.equal(offRow.enabled, false);
});
