import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// index.html and the modules that reach into it are a contract nothing was checking.
// PR #92 branched before #91 and merged without rebasing, silently deleting the
// `#diff-layout-inline`/`#diff-layout-split` buttons; diff-view.js grabs both at
// MODULE SCOPE and calls `.classList` on them immediately, so the whole module graph
// threw on load and the dashboard rendered blank. CI was green — no test reads
// index.html.
//
// Deliberately narrow: only `const x = document.getElementById('literal')` starting at
// COLUMN 0, i.e. a module-scope grab that runs at import time. That's exactly the
// crash-on-load shape. Lookups inside functions are excluded on purpose — plenty of
// them target elements this app injects at runtime (settings.js builds
// `#settings-panel-*`), so widening this would produce false failures, not coverage.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)));
const MODULE_SCOPE_LOOKUP = /^(?:const|let|var)\s+[\w$]+\s*=\s*document\.getElementById\('([^']+)'\)/gm;

test('every module-scope getElementById id exists in index.html', () => {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(declared.size > 100, `expected index.html's id set, found ${declared.size}`);

  const missing = [];
  for (const file of readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    const src = readFileSync(join(PUBLIC_DIR, file), 'utf8');
    for (const [, id] of src.matchAll(MODULE_SCOPE_LOOKUP)) {
      if (!declared.has(id)) missing.push(`${file} reads #${id}, which index.html does not define`);
    }
  }
  assert.deepEqual(missing, [], `module-scope element lookups with no matching id:\n${missing.join('\n')}`);
});
