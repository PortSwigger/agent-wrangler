import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeRollbackMarker, readRolledBack, ROLLBACK_MARKER } from '../server/self-update.js';

const SCRIPT = fileURLToPath(new URL('./update-rollback.sh', import.meta.url));

function installWithUpdate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-rollback-'));
  const install = path.join(root, 'install');
  const dataDir = path.join(root, 'data');
  const git = (...args) => execFileSync('git', args, { cwd: install, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(install, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(install, 'scripts', 'update-rollback.sh'));
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'good');
  const previous = git('rev-parse', 'HEAD');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'broken');
  const target = git('rev-parse', 'HEAD');
  writeRollbackMarker({ previous, target }, { dataDir });
  const start = () => execFileSync('bash', [path.join(install, 'scripts', 'update-rollback.sh')], {
    env: { ...process.env, AW_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  return { root, dataDir, previous, target, start, head: () => git('rev-parse', 'HEAD') };
}

test('the first starts after an update count attempts and leave the new code in place', (t) => {
  const r = installWithUpdate();
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.start();
  r.start();
  assert.equal(r.head(), r.target);
  assert.match(fs.readFileSync(path.join(r.dataDir, ROLLBACK_MARKER), 'utf8'), /attempts=2/);
  assert.equal(readRolledBack({ dataDir: r.dataDir }), null);
});

test('the third start without the server clearing the marker rolls back', (t) => {
  const r = installWithUpdate();
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.start();
  r.start();
  const out = r.start();
  assert.equal(r.head(), r.previous);
  assert.match(out, /rolled back/);
  assert.equal(fs.existsSync(path.join(r.dataDir, ROLLBACK_MARKER)), false);
  const note = readRolledBack({ dataDir: r.dataDir });
  assert.equal(note.previous, r.previous);
  assert.equal(note.target, r.target);
});

test('no marker means nothing happens', (t) => {
  const r = installWithUpdate();
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  fs.rmSync(path.join(r.dataDir, ROLLBACK_MARKER));
  r.start();
  r.start();
  r.start();
  assert.equal(r.head(), r.target);
});
