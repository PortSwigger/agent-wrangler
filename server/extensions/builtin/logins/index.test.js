import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import extension from './index.js';
import { LoginStore } from './login-store.js';
import { validateManifest, loadExtensions } from '../../index.js';

test('Logins manifest is valid, optional, API 1.48 and contributes only safe graph data', (t) => {
  assert.doesNotThrow(() => validateManifest(extension));
  assert.equal(extension.engines.wranglerApi, '^1.48.0');
  assert.equal(extension.defaultEnabled, false);
  assert.equal(loadExtensions({ cfg: {}, builtin: [extension] }).list[0].enabled, false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-login-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new LoginStore(root);
  assert.deepEqual(extension.graph({ host: { stores: { logins: store } } }), { logins: { logins: [], sessions: {} } });
});

test('Logins static imports stay inside its leaf boundary', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const allowed = ['data-dir.js', 'atomic-json.js'].map((name) => path.resolve(dir, '../../..', name));
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return; seen.add(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('node:')) continue;
      const target = path.resolve(path.dirname(file), match[1]);
      assert.ok(target.startsWith(`${dir}/`) || allowed.includes(target), target);
      if (target.startsWith(`${dir}/`)) visit(target);
    }
  };
  visit(path.join(dir, 'index.js'));
});
