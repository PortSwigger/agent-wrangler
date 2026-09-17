import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extensionEnabledHandler } from './extension-enabled.js';
import { routeControlMessage } from '../router.js';
import { readConfig } from '../../config-store.js';
import { loadExtensions, registerExtension, unregisterExtension, quarantineExtension } from '../../extensions/index.js';
import { DATA_DIR } from '../../data-dir.js';
import { writeJsonAtomic } from '../../atomic-json.js';

// AW_DATA_DIR is redirected to a per-process temp dir by server/test-setup.js,
// so this writes a throwaway config.json, never the real one. Snapshot/restore
// anyway so the file's other keys survive for sibling tests in this process.
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
async function withConfig(initial, fn) {
  let saved = null;
  try { saved = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { /* absent */ }
  writeJsonAtomic(CONFIG_PATH, initial, { trailingNewline: true });
  try { return await fn(); } finally {
    if (saved === null) { try { fs.rmSync(CONFIG_PATH); } catch { /* nothing */ } } else fs.writeFileSync(CONFIG_PATH, saved);
  }
}

function manifest(id, overrides = {}) {
  return {
    id,
    label: id,
    defaultEnabled: true,
    tools: [{ name: `${id}_tool`, handler() {} }],
    skills: [id],
    ...overrides,
  };
}

// The core-owned bag index.js builds (extBag): `list`/`manifests` come straight
// off the loaded registry, `register`/`unregister` are the leaf's own verbs, and
// activate/deactivate are recorded so a test asserts the WIRING as well as the
// registry effect — the two halves land in different files and only this handler
// makes them one flip.
function ctx(builtin, cfg = {}, { onActivate } = {}) {
  const loaded = loadExtensions({ cfg, builtin });
  const calls = { rebuild: 0, replies: [], activated: [], deactivated: [], quarantined: [], changed: 0 };
  return {
    calls,
    loaded,
    ext: {
      list: loaded.list,
      manifests: loaded._manifests,
      register: (m, o) => registerExtension(loaded, m, o),
      unregister: (id, o) => unregisterExtension(loaded, id, o),
      activate: (id) => { calls.activated.push(id); onActivate?.(id); },
      deactivate: (id) => { calls.deactivated.push(id); },
      quarantine: (id, err) => {
        calls.quarantined.push(id);
        quarantineExtension(loaded, id, err?.message || String(err));
      },
      changed: () => { calls.changed += 1; },
    },
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.replies.push(obj),
  };
}

test('extension-enabled writes extensions.<id>, preserving sibling extensions and other keys, then rebuilds', async () => {
  await withConfig({ tmuxSocket: 'aw-1', extensions: { other: false } }, async () => {
    const c = ctx([manifest('checklist'), manifest('other')], { extensions: { other: false } });
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'checklist', enabled: false }, c);
    assert.deepEqual(readConfig(), { tmuxSocket: 'aw-1', extensions: { other: false, checklist: false } });
    assert.equal(c.calls.rebuild, 1);
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'checklist', enabled: 'yes' }, c);
    assert.equal(readConfig().extensions.checklist, true, 'coerced to a real boolean');
  });
});

test('an unknown extension id throws — and reaches the client as the router\'s error envelope', async () => {
  await withConfig({}, async () => {
    const c = ctx([manifest('checklist')]);
    await assert.rejects(
      () => extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'nope', enabled: true }, c),
      /Unknown extension: nope/,
    );
    await routeControlMessage(JSON.stringify({ type: 'extension-enabled', id: 'nope', enabled: true }), c);
    assert.equal(c.calls.replies.length, 1);
    assert.equal(c.calls.replies[0].type, 'error');
    assert.match(c.calls.replies[0].message, /Unknown extension: nope/);
    assert.equal(c.calls.rebuild, 0);
    assert.deepEqual(readConfig(), {}, 'nothing written');
  });
});

// The live half. An extension that booted OFF staged nothing, so turning it on
// has to re-stage its manifest before anything can be activated — which is what
// the loader's `_manifests` map exists for.
test('enabling a boot-disabled extension re-stages its contributions and activates it', async () => {
  await withConfig({ extensions: { notes: false } }, async () => {
    const c = ctx([manifest('notes')], { extensions: { notes: false } });
    assert.deepEqual(c.loaded.tools, [], 'nothing staged at boot');
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'notes', enabled: true }, c);
    assert.deepEqual(c.loaded.tools.map((t) => t.name), ['notes_tool']);
    assert.deepEqual(c.loaded.skillIds, ['notes']);
    assert.deepEqual(c.loaded.disabledSkillIds, []);
    assert.deepEqual(c.calls.activated, ['notes']);
    assert.equal(c.calls.changed, 1, 'the router map and the client announcement both ride this');
    assert.equal(c.calls.rebuild, 1);
  });
});

test('an activation that throws quarantines the row exactly as boot would, and registers nothing', async () => {
  await withConfig({ extensions: { notes: false } }, async () => {
    const c = ctx([manifest('notes')], { extensions: { notes: false } }, {
      onActivate: () => { throw new Error('store factory exploded'); },
    });
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'notes', enabled: true }, c);
    const entry = c.loaded.list.find((e) => e.id === 'notes');
    assert.equal(entry.quarantine, 'store factory exploded');
    assert.equal(entry.enabled, false);
    assert.deepEqual(c.loaded.tools, [], 'the half-registered contributions are taken back');
    assert.deepEqual(c.calls.quarantined, ['notes']);
    assert.equal(c.calls.changed, 1, 'the client still has to be told the row changed');
  });
});

test('disabling deactivates, deregisters and KEEPS the row', async () => {
  await withConfig({}, async () => {
    const c = ctx([manifest('notes'), manifest('other')]);
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'notes', enabled: false }, c);
    assert.deepEqual(c.calls.deactivated, ['notes']);
    assert.deepEqual(c.loaded.list.map((e) => e.id), ['notes', 'other'], 'the row carries the toggle that turns it back on');
    assert.equal(c.loaded.list[0].enabled, false);
    assert.deepEqual(c.loaded.tools.map((t) => t.name), ['other_tool']);
    assert.deepEqual(c.loaded.disabledSkillIds, ['notes']);
    assert.equal(c.loaded._reg.toolNames.has('notes_tool'), false, 'the name is released, so a re-enable can claim it again');
    assert.equal(c.calls.changed, 1);
  });
});

test('a flip is reversible in-process — off, then on again, with no duplicate row', async () => {
  await withConfig({}, async () => {
    const c = ctx([manifest('notes')]);
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'notes', enabled: false }, c);
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'notes', enabled: true }, c);
    assert.deepEqual(c.loaded.list.map((e) => e.id), ['notes']);
    assert.deepEqual(c.loaded.tools.map((t) => t.name), ['notes_tool']);
    assert.deepEqual(c.calls.activated, ['notes']);
    assert.deepEqual(c.calls.deactivated, ['notes']);
  });
});

// A quarantined row has nothing to re-stage — discovery may never have read a
// manifest at all — so the toggle writes the config value and stops there
// rather than throwing at a human who pressed a switch.
test('toggling a quarantined extension writes config and touches the registry no further', async () => {
  await withConfig({}, async () => {
    const c = ctx([{ id: 'dud', external: true, quarantine: 'no index.js' }]);
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'dud', enabled: true }, c);
    assert.equal(readConfig().extensions.dud, true);
    assert.deepEqual(c.calls.activated, []);
    assert.equal(c.calls.changed, 0);
    assert.equal(c.calls.rebuild, 1);
  });
});
