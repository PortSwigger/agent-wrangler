import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, readJsonOrLoud } from './atomic-json.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aw-atomic-'));
}

test('writeJsonAtomic writes valid JSON that round-trips', () => {
  const file = path.join(tmpDir(), 'state.json');
  const obj = { a: 1, b: ['x', 'y'], nested: { ok: true } };
  writeJsonAtomic(file, obj);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), obj);
});

test('writeJsonAtomic matches the 2-space + no-trailing-newline format by default', () => {
  const file = path.join(tmpDir(), 'state.json');
  writeJsonAtomic(file, { a: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1\n}');
});

test('writeJsonAtomic appends a trailing newline when asked (config format)', () => {
  const file = path.join(tmpDir(), 'config.json');
  writeJsonAtomic(file, { a: 1 }, { trailingNewline: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
});

test('writeJsonAtomic leaves no temp file behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('writeJsonAtomic creates the parent directory', () => {
  const file = path.join(tmpDir(), 'deep', 'nested', 'state.json');
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
});

test('readJsonOrLoud round-trips a file written by writeJsonAtomic', () => {
  const file = path.join(tmpDir(), 'state.json');
  writeJsonAtomic(file, { hello: 'world' });
  assert.deepEqual(readJsonOrLoud(file), { hello: 'world' });
});

test('readJsonOrLoud returns null and stays silent for a missing file (first run)', () => {
  const file = path.join(tmpDir(), 'absent.json');
  assert.equal(readJsonOrLoud(file), null);
});

test('readJsonOrLoud returns null and stays silent for an empty file (first run)', () => {
  const file = path.join(tmpDir(), 'empty.json');
  fs.writeFileSync(file, '');
  assert.equal(readJsonOrLoud(file), null);
  // whitespace-only is also a clean first run, not corruption
  const ws = path.join(tmpDir(), 'ws.json');
  fs.writeFileSync(ws, '   \n');
  assert.equal(readJsonOrLoud(ws), null);
});

test('readJsonOrLoud on a corrupt non-empty file: backs it up, logs loudly, returns null', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'mappings.json');
  fs.writeFileSync(file, '{ "torn": tru');
  const errors = [];
  const orig = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    assert.equal(readJsonOrLoud(file, 'mappings.json'), null);
  } finally {
    console.error = orig;
  }
  // The corrupt bytes are preserved verbatim, not discarded.
  assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), '{ "torn": tru');
  // The canonical path is left absent so the next boot is a clean first run and
  // doesn't re-fire the corruption path on the same bytes.
  assert.equal(fs.existsSync(file), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /mappings\.json is corrupt/);
  assert.match(errors[0], /\.corrupt/);
});

test('readJsonOrLoud does not clobber an existing corrupt backup (counter suffix)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(`${file}.corrupt`, 'older backup');
  fs.writeFileSync(file, 'not json');
  const orig = console.error;
  console.error = () => {};
  try {
    readJsonOrLoud(file, 'tasks.json');
  } finally {
    console.error = orig;
  }
  assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), 'older backup');
  assert.equal(fs.readFileSync(`${file}.corrupt.1`, 'utf8'), 'not json');
});
