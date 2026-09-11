import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The board's frontend is a graph of ES modules the browser loads directly, and
// NOTHING in this suite imports the big ones (app.js pulls in xterm, WebSocket and
// the live DOM, so it can't be imported under node:test). That blind spot shipped a
// blank dashboard: a ternary with no else branch — `${cond ? `…`}` — made app.js
// unparseable, every module in the graph failed with it, and CI stayed green because
// no test ever touched the file.
//
// `node --check` is the cheap half of the fix: it parses without executing, so it
// needs no DOM at all. package.json is `type: module`, so a bare .js here is already
// parsed as ESM — don't "fix" this by copying to a .mjs temp file.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)));

// The walk (the same one element-ids.test.js does — kept as its own copy, since
// importing a test file would register its tests twice) covers public/ AND
// every extension's client under server/extensions/<id>/public/. Those are
// served to the same browser, and an unparseable one is dropped by extensions.js
// at load — quieter than a blank board, but still a silently missing feature.
function frontendModules() {
  const out = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => join(PUBLIC_DIR, f));
  const extRoot = join(PUBLIC_DIR, '..', 'server', 'extensions');
  for (const ext of readdirSync(extRoot, { withFileTypes: true })) {
    if (!ext.isDirectory()) continue;
    const pub = join(extRoot, ext.name, 'public');
    let files = [];
    try { files = readdirSync(pub); } catch { continue; }
    out.push(...files.filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => join(pub, f)));
  }
  return out;
}

test('every frontend module parses', () => {
  const files = frontendModules();
  assert.ok(files.length > 20, `expected the frontend module set, found ${files.length}`);
  assert.ok(files.some((f) => f.includes(join('server', 'extensions', 'checklist', 'public'))), 'the walk must reach the checklist extension\'s client');

  const broken = [];
  for (const path of files) {
    const file = relative(join(PUBLIC_DIR, '..'), path);
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (err) {
      broken.push(`${file}: ${String(err.stderr || err).split('\n').find((l) => l.includes('Error')) || 'parse failed'}`);
    }
  }
  assert.deepEqual(broken, [], `frontend modules failed to parse:\n${broken.join('\n')}`);
});
