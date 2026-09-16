import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

// activateExtension/deactivateExtension bind the singletons this file owns, so
// they cannot be imported and exercised the way a leaf can — index.js starts a
// server on import. These are static guards over the handful of details that
// are invisible-until-production: a wrong one degrades silently (a hook that
// keeps firing for a disabled extension, a sweep that never stops) rather than
// throwing anywhere a test would see. Same technique as ext-deliver.test.js's
// wiring assertion and public/module-syntax.test.js.

test('a session hook is TAGGED with its extension, and deactivate filters on that tag', () => {
  assert.match(SRC, /bound\.extId = extId;/, 'the wrapper carries the tag; the raw hook is not the thing in the list');
  assert.match(SRC, /_extHooks\[name\]\.filter\(\(fn\) => fn\.extId !== id\)/, 'deactivate removes one extension\'s hooks and leaves its siblings');
});

test('every sweep an activation starts is held, and deactivate clears them', () => {
  assert.match(SRC, /const sweepHandles = new Map\(\)/);
  assert.match(SRC, /for \(const t of sweepHandles\.get\(id\) \|\| \[\]\) clearInterval\(t\)/, 'a disabled extension must stop ticking against a façade it no longer has');
});

test('activation is all-or-nothing: its own catch deactivates before rethrowing', () => {
  assert.match(SRC, /\} catch \(err\) \{\s*deactivateExtension\(id\);\s*throw err;/, 'a store built before the step that threw would otherwise outlive the failure');
  assert.match(SRC, /function quarantineFor\(id, err\) \{\s*deactivateExtension\(id\);/, 'a LIVE quarantine has a façade and stores to take back, unlike a boot one');
});

test('boot defers sweeps until after the instance lock, and a live activation does not', () => {
  assert.match(SRC, /activateExtension\(e\.id, \{ startSweeps: false \}\)/, 'a duplicate instance must not sweep a DATA_DIR it is about to be refused');
  assert.match(SRC, /for \(const id of hostApis\.keys\(\)\) startSweepsFor\(id\)/);
});

test('the core bag carries the four registry verbs plus the one seam every change ends with', () => {
  for (const verb of ['register:', 'unregister:', 'activate:', 'deactivate:', 'quarantine:', 'manifests:', 'changed:']) {
    assert.ok(SRC.includes(`  ${verb}`), `extBag is missing ${verb}`);
  }
  assert.match(SRC, /invalidateHandlerMap\(\);/, 'the router\'s cached handler map is the one thing that does not re-read the registry');
});
