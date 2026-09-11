import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extensionEnabledHandler } from './extension-enabled.js';
import { routeControlMessage } from '../router.js';
import { readConfig } from '../../config-store.js';
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

function ctx() {
  const calls = { rebuild: 0, replies: [] };
  return {
    calls,
    ext: { list: [{ id: 'checklist', enabled: true }, { id: 'other', enabled: false }], stores: {} },
    rebuild: async () => { calls.rebuild += 1; },
    reply: (obj) => calls.replies.push(obj),
  };
}

test('extension-enabled writes extensions.<id>, preserving sibling extensions and other keys, then rebuilds', async () => {
  await withConfig({ tmuxSocket: 'aw-1', extensions: { other: false } }, async () => {
    const c = ctx();
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'checklist', enabled: false }, c);
    assert.deepEqual(readConfig(), { tmuxSocket: 'aw-1', extensions: { other: false, checklist: false } });
    assert.equal(c.calls.rebuild, 1);
    await extensionEnabledHandler.handler({ type: 'extension-enabled', id: 'checklist', enabled: 'yes' }, c);
    assert.equal(readConfig().extensions.checklist, true, 'coerced to a real boolean');
  });
});

test('an unknown extension id throws — and reaches the client as the router\'s error envelope', async () => {
  await withConfig({}, async () => {
    const c = ctx();
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
