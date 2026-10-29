import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claude } from '../server/agents/claude.js';
import { codex } from '../server/agents/codex.js';
import { chooseLaunchMode, launchPreview, readModePreferences, saveModePreference } from './launch-modes.js';

const agents = [codex, claude];
test('per-agent preferences, defaults and stale choices remain separate', () => {
  const storage = { value: null, getItem() { return this.value; }, setItem(_k, value) { this.value = value; } };
  assert.equal(chooseLaunchMode(codex.launchModes).id, 'locked');
  assert.equal(chooseLaunchMode(claude.launchModes).id, 'auto');
  saveModePreference(storage, 'codex', 'full');
  saveModePreference(storage, 'claude', 'acceptEdits');
  const remembered = readModePreferences(storage);
  for (const agent of agents) assert.equal(chooseLaunchMode(agent.launchModes, remembered[agent.id]).id, remembered[agent.id]);
  assert.equal(chooseLaunchMode(codex.launchModes, 'deleted-mode').id, 'locked');
  assert.equal(chooseLaunchMode(undefined), null);
  storage.value = 'bad json';
  assert.deepEqual(readModePreferences(storage), {});
});
test('own-launch Claude runtimes use Auto without losing the remembered mode', () => {
  assert.equal(chooseLaunchMode(claude.launchModes, 'acceptEdits', true).id, 'auto');
  assert.equal(chooseLaunchMode(claude.launchModes, 'acceptEdits', false).id, 'acceptEdits');
});
test('preview includes adapter flags, quoted folder paths and suppresses Full folders', () => {
  const dirs = ["/tmp/a folder's data"];
  for (const agent of agents) for (const mode of agent.launchModes.modes) {
    const preview = launchPreview(agent.id, mode, dirs);
    for (const flag of mode.flags) assert.ok(preview.includes(flag));
    if (mode.folders) assert.ok(preview.includes("'/tmp/a folder'\\''s data'"));
    else assert.ok(!preview.includes('--add-dir'));
  }
});

test('mode and folder wrappers have explicit hidden rules for the dialog stylesheet', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.ok(/\.launch-modes\.hidden\s*,\s*#m-writable-folders\.hidden\s*\{\s*display:\s*none/.test(css), 'the new wrappers must explicitly support hidden, since there is no global hidden rule');
});

function chooserHarness() {
  const nodes = new Map();
  const classes = new Set();
  const node = () => ({ classList: { toggle() {} }, setAttribute() {}, replaceChildren() {} });
  const root = {
    classList: { toggle(name, hidden) { hidden ? classes.add(name) : classes.delete(name); } },
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    addEventListener() {},
  };
  const storage = { getItem: () => JSON.stringify({ claude: 'bypassPermissions', codex: 'full' }), setItem() {} };
  return { root, classes, storage, folders: node(), preview: node(), dirs: () => [], onChange() {} };
}

test('saved schedule mode beats browser preference when discovery metadata arrives late', async () => {
  const { createLaunchModeChooser } = await import('./launch-modes.js');
  for (const adapter of agents) {
    const h = chooserHarness();
    const chooser = createLaunchModeChooser(h);
    chooser.open();
    chooser.restore({ agent: adapter.id, [adapter.launchModes.field]: adapter.launchModes.modes[0].id }, [{ id: 'claude' }]);
    chooser.sync({ id: adapter.id });
    assert.deepEqual(chooser.fields(), {});
    assert.equal(h.classes.has('hidden'), true);
    chooser.sync(adapter);
    assert.equal(chooser.fields()[adapter.launchModes.field], adapter.launchModes.modes[0].id);
    chooser.open();
    chooser.sync(adapter);
    assert.equal(chooser.fields()[adapter.launchModes.field], adapter.id === 'codex' ? 'full' : 'bypassPermissions');
  }
});

test('saved legacy schedule uses the adapter default and runtime gating preserves its choice', async () => {
  const { createLaunchModeChooser } = await import('./launch-modes.js');
  const chooser = createLaunchModeChooser(chooserHarness());
  chooser.open();
  chooser.restore({ agent: 'claude' });
  chooser.sync(claude);
  assert.deepEqual(chooser.fields(), { permissionMode: 'auto' });
  chooser.open();
  chooser.sync(claude, true);
  assert.deepEqual(chooser.fields(), { permissionMode: 'auto' });
  chooser.sync(claude, false);
  assert.deepEqual(chooser.fields(), { permissionMode: 'bypassPermissions' });
});
