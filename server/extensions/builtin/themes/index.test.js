import { test } from 'node:test';
import assert from 'node:assert/strict';
import manifest, { readThemes, listThemesHandler } from './index.js';
import { validateManifest } from '../../index.js';
import { listStyles } from '../../../styles.js';

const IDS = ['cyberpunk', 'dolphin', 'pink', 'pixel-cats', 'wrangler'];

test('ships the bundled themes under their existing ids, on by default', () => {
  assert.ok(validateManifest(manifest));
  assert.equal(manifest.defaultEnabled, true);
  assert.deepEqual(readThemes().map((t) => t.id), IDS);
  assert.deepEqual(listStyles([{ id: 'themes', dir: `${manifest.dir}/themes` }], '/nonexistent').map((s) => s.id), IDS);
});

test('one hidden toggle per theme, keyed in camelCase and naming its theme', () => {
  assert.deepEqual(manifest.settings.map((s) => [s.key, s.type, s.theme, s.hidden]), [
    ['cyberpunk', 'toggle', 'cyberpunk', true],
    ['dolphin', 'toggle', 'dolphin', true],
    ['pink', 'toggle', 'pink', true],
    ['pixelCats', 'toggle', 'pixel-cats', true],
    ['wrangler', 'toggle', 'wrangler', true],
  ]);
});

test('themes-list replies with every theme\'s manifest, switched off or not', () => {
  let sent;
  listThemesHandler.handler({ reqId: 'r1' }, {}, (m) => { sent = m; });
  assert.equal(sent.kind, 'themes');
  assert.equal(sent.reqId, 'r1');
  assert.deepEqual(sent.themes.map((t) => [t.id, t.manifest.name]), [
    ['cyberpunk', 'Cyberpunk'], ['dolphin', 'Dolphin'], ['pink', 'Pink'], ['pixel-cats', 'Pixel Cats'], ['wrangler', 'Wrangler'],
  ]);
});
