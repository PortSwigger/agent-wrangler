import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

test('every frontend module parses', () => {
  const files = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  assert.ok(files.length > 20, `expected the frontend module set, found ${files.length}`);

  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', join(PUBLIC_DIR, file)], { stdio: 'pipe' });
    } catch (err) {
      broken.push(`${file}: ${String(err.stderr || err).split('\n').find((l) => l.includes('Error')) || 'parse failed'}`);
    }
  }
  assert.deepEqual(broken, [], `frontend modules failed to parse:\n${broken.join('\n')}`);
});
