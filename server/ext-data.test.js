import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { extDataDir, ensureExtDataDir, extDataRoot } from './ext-data.js';

test('extDataDir is DATA_DIR/ext-data/<id> and refuses an id that is not a safe segment', () => {
  assert.equal(extDataRoot(), path.join(DATA_DIR, 'ext-data'));
  assert.equal(extDataDir('jobs'), path.join(DATA_DIR, 'ext-data', 'jobs'));
  for (const bad of ['', '..', '../x', 'a/b', 'A', '-x', null, undefined]) assert.throws(() => extDataDir(bad), /Extension id/);
});

test('ensureExtDataDir creates the folder owner-only and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-extdata-'));
  try {
    const dir = ensureExtDataDir('probe', root);
    assert.equal(dir, path.join(root, 'ext-data', 'probe'));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    fs.writeFileSync(path.join(dir, 'keep'), 'x');
    assert.equal(ensureExtDataDir('probe', root), dir);
    assert.equal(fs.readFileSync(path.join(dir, 'keep'), 'utf8'), 'x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureExtDataDir refuses a symlinked extension folder or ext-data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-extdata-'));
  try {
    const beta = ensureExtDataDir('beta', root);
    fs.symlinkSync(beta, path.join(root, 'ext-data', 'alpha'));
    assert.throws(() => ensureExtDataDir('alpha', root), /symlink/);
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(other, 'ext-data'), { recursive: true });
    fs.symlinkSync(path.join(other, 'ext-data'), path.join(other, 'linked'));
    fs.mkdirSync(path.join(root, 'd2'));
    fs.symlinkSync(path.join(other, 'ext-data'), path.join(root, 'd2', 'ext-data'));
    assert.throws(() => ensureExtDataDir('alpha', path.join(root, 'd2')), /symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
