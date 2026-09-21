import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extSettingSetHandler, MAX_TEXT_LENGTH } from './ext-setting-set.js';
import { routeControlMessage } from '../router.js';
import { readConfig } from '../../config-store.js';
import { loadExtensions, quarantineExtension } from '../../extensions/index.js';
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

const DEFS = [
  { key: 'registryUrl', type: 'text', label: 'Registry URL' },
  { key: 'pollMs', type: 'number', label: 'Poll interval' },
  { key: 'auto', type: 'toggle', label: 'Auto-deliver' },
];

function manifest(id, overrides = {}) {
  return { id, label: id, defaultEnabled: true, settings: DEFS, ...overrides };
}

// The core bag index.js builds, cut down to what this handler touches: `list`
// off the loaded registry, plus the two things the handler must be asserted
// about — that it rebuilds, and that it does NOT announce a registry change.
function ctx(builtin, { quarantine } = {}) {
  const loaded = loadExtensions({ cfg: {}, builtin });
  if (quarantine) quarantineExtension(loaded, quarantine, 'store factory threw');
  const calls = { rebuild: 0, changed: 0, replies: [] };
  return {
    calls,
    loaded,
    ext: { list: loaded.list, changed: () => { calls.changed += 1; } },
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.replies.push(obj),
  };
}

const set = (c, msg) => extSettingSetHandler.handler({ type: 'ext-setting-set', ...msg }, c);

test('a text value is stored under extensionSettings.<id>.<key> and the board rebuilt', async () => {
  await withConfig({ tmuxSocket: 'aw-1', extensions: { demo: true } }, async () => {
    const c = ctx([manifest('demo')]);
    await set(c, { id: 'demo', key: 'registryUrl', value: 'https://reg.invalid' });
    assert.deepEqual(readConfig(), {
      tmuxSocket: 'aw-1', extensions: { demo: true },
      extensionSettings: { demo: { registryUrl: 'https://reg.invalid' } },
    });
    assert.equal(c.calls.rebuild, 1);
    // Nothing about the REGISTRY moved, so the client manifest must not be
    // re-broadcast: that would make every tab re-evaluate its extension
    // modules for a value edit.
    assert.equal(c.calls.changed, 0);
  });
});

test('an unknown extension, a quarantined one and an undeclared key are all refused', async () => {
  await withConfig({}, async () => {
    const c = ctx([manifest('demo')]);
    await assert.rejects(() => set(c, { id: 'nope', key: 'registryUrl', value: 'x' }), /Unknown extension: nope/);
    await assert.rejects(() => set(c, { id: 'demo', key: 'nope', value: 'x' }), /Extension demo has no setting "nope"/);
    // The declaring manifest's own defs are the only authority for what a key
    // may hold, so a key it never declared has nothing to validate against.
    assert.deepEqual(readConfig(), {}, 'nothing written');
    assert.equal(c.calls.rebuild, 0);

    const q = ctx([manifest('demo')], { quarantine: 'demo' });
    await assert.rejects(() => set(q, { id: 'demo', key: 'registryUrl', value: 'x' }), /Extension demo is quarantined/);
    assert.deepEqual(readConfig(), {}, 'a choice stored against a feature that is not there');
  });
});

test('a refusal reaches the client as the router\'s error envelope', async () => {
  await withConfig({}, async () => {
    const c = ctx([manifest('demo')]);
    await routeControlMessage(JSON.stringify({ type: 'ext-setting-set', id: 'demo', key: 'pollMs', value: 'abc' }), c);
    assert.equal(c.calls.replies.length, 1);
    assert.equal(c.calls.replies[0].type, 'error');
    assert.match(c.calls.replies[0].message, /Setting demo.pollMs must be a number/);
    assert.equal(c.calls.rebuild, 0);
  });
});

test('the DEF\'s type decides how value is read — never anything off the browser-supplied frame', async () => {
  await withConfig({}, async () => {
    const c = ctx([manifest('demo')]);
    // toggle: coerced, because a switch has exactly two positions.
    await set(c, { id: 'demo', key: 'auto', value: 'yes' });
    assert.equal(readConfig().extensionSettings.demo.auto, true);
    await set(c, { id: 'demo', key: 'auto', value: null });
    assert.equal(readConfig().extensionSettings.demo.auto, false);
    // number: parsed, and refused rather than coerced when it is not one —
    // silently storing 0 for "abc" would make the row lie about what is stored.
    await set(c, { id: 'demo', key: 'pollMs', value: '15' });
    assert.equal(readConfig().extensionSettings.demo.pollMs, 15);
    await set(c, { id: 'demo', key: 'pollMs', value: 0 });
    assert.equal(readConfig().extensionSettings.demo.pollMs, 0);
    for (const value of ['abc', NaN, Infinity, -Infinity, {}]) {
      await assert.rejects(() => set(c, { id: 'demo', key: 'pollMs', value }), /Setting demo.pollMs must be a number/);
    }
    assert.equal(readConfig().extensionSettings.demo.pollMs, 0, 'the last good value stands');
    // An empty field clears a number rather than storing 0 for it.
    await set(c, { id: 'demo', key: 'pollMs', value: '' });
    assert.equal(readConfig().extensionSettings.demo.pollMs, null);
    await set(c, { id: 'demo', key: 'pollMs', value: null });
    assert.equal(readConfig().extensionSettings.demo.pollMs, null);
    // text: a string, and a bounded one.
    for (const value of [7, null, { toString: () => 'x' }]) {
      await assert.rejects(() => set(c, { id: 'demo', key: 'registryUrl', value }), /Setting demo.registryUrl must be a string/);
    }
    await assert.rejects(
      () => set(c, { id: 'demo', key: 'registryUrl', value: 'x'.repeat(MAX_TEXT_LENGTH + 1) }),
      /Setting demo.registryUrl is too long/,
    );
    await set(c, { id: 'demo', key: 'registryUrl', value: '' });
    assert.equal(readConfig().extensionSettings.demo.registryUrl, '', 'an empty string is how text is cleared');
  });
});

test('one extension\'s write leaves another\'s block and its own other keys alone', async () => {
  await withConfig({ extensionSettings: { other: { keep: 'me' }, demo: { auto: true } } }, async () => {
    const c = ctx([manifest('demo'), manifest('other', { settings: [{ key: 'keep', type: 'text', label: 'Keep' }] })]);
    await set(c, { id: 'demo', key: 'registryUrl', value: 'https://reg.invalid' });
    assert.deepEqual(readConfig().extensionSettings, {
      other: { keep: 'me' },
      demo: { auto: true, registryUrl: 'https://reg.invalid' },
    });
  });
});

// -- declared constraints ---------------------------------------------------
// The panel mirrors these onto the native input, but THIS is the enforcement,
// and it rejects rather than clamps. Nothing is written on a rejection.
const CONSTRAINED = [
  { key: 'pollSeconds', type: 'number', label: 'Poll interval', min: 15, max: 600, step: 15 },
  { key: 'fine', type: 'number', label: 'Fine', step: 0.1 },
  { key: 'registryUrl', type: 'text', label: 'Registry URL', maxLength: 30, pattern: 'https://.*' },
  { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'fast', label: 'Fast' }, { value: 'slow', label: 'Slow' }] },
];
const constrained = () => ctx([{ id: 'demo', label: 'demo', defaultEnabled: true, settings: CONSTRAINED }]);
const stored = (key) => readConfig().extensionSettings?.demo?.[key];

test('a number outside min/max or off the declared step is rejected, and nothing is written', async () => {
  await withConfig({}, async () => {
    const c = constrained();
    await assert.rejects(() => set(c, { id: 'demo', key: 'pollSeconds', value: 10 }), /Setting demo.pollSeconds must be at least 15/);
    await assert.rejects(() => set(c, { id: 'demo', key: 'pollSeconds', value: 900 }), /Setting demo.pollSeconds must be at most 600/);
    await assert.rejects(() => set(c, { id: 'demo', key: 'pollSeconds', value: 20 }), /Setting demo.pollSeconds must be 15 plus a multiple of 15/);
    assert.equal(stored('pollSeconds'), undefined, 'a rejected value writes nothing');
    await set(c, { id: 'demo', key: 'pollSeconds', value: 45 });
    assert.equal(stored('pollSeconds'), 45);
    // The step tolerance exists for exactly this: 0.1 steps produce quotients
    // no binary float represents exactly.
    await set(c, { id: 'demo', key: 'fine', value: 0.3 });
    assert.equal(stored('fine'), 0.3);
    await assert.rejects(() => set(c, { id: 'demo', key: 'fine', value: 0.35 }), /must be a multiple of 0.1/);
  });
});

test('a text value is bounded by maxLength and anchored FULL-STRING against pattern', async () => {
  await withConfig({}, async () => {
    const c = constrained();
    await assert.rejects(() => set(c, { id: 'demo', key: 'registryUrl', value: 'x'.repeat(31) }), /Setting demo.registryUrl is too long \(max 30 characters\)/);
    await assert.rejects(() => set(c, { id: 'demo', key: 'registryUrl', value: 'ftp://reg.invalid' }), /Setting demo.registryUrl does not match the required format/);
    // A SUBSTRING match is not a match: the server anchors the pattern exactly
    // as HTML's implicitly-anchored `pattern` attribute does.
    await assert.rejects(() => set(c, { id: 'demo', key: 'registryUrl', value: 'go to https://reg.invalid now' }), /does not match the required format/);
    assert.equal(stored('registryUrl'), undefined);
    await set(c, { id: 'demo', key: 'registryUrl', value: 'https://reg.invalid' });
    assert.equal(stored('registryUrl'), 'https://reg.invalid');
  });
});

test('a select stores only a declared option value', async () => {
  await withConfig({}, async () => {
    const c = constrained();
    await assert.rejects(() => set(c, { id: 'demo', key: 'mode', value: 'medium' }), /Setting demo.mode must be one of "fast", "slow"/);
    assert.equal(stored('mode'), undefined);
    await set(c, { id: 'demo', key: 'mode', value: 'slow' });
    assert.equal(stored('mode'), 'slow');
  });
});

test('clearing skips every constraint — that is a select\'s only clearing route', async () => {
  await withConfig({}, async () => {
    const c = constrained();
    await set(c, { id: 'demo', key: 'pollSeconds', value: null });
    assert.equal(stored('pollSeconds'), null);
    await set(c, { id: 'demo', key: 'registryUrl', value: '' });
    assert.equal(stored('registryUrl'), '');
    await set(c, { id: 'demo', key: 'mode', value: '' });
    assert.equal(stored('mode'), '');
  });
});
