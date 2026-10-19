import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtFiles } from './ext-files.js';
import { readSafeFile, checkPathShape } from './safe-file.js';
import { FILE_KIND_LIMITS } from '../public/file-types.js';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-files-')));
const f = (n) => path.join(dir, n);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(f('a.md'), '# Hello');
fs.writeFileSync(f('p.png'), PNG);
fs.writeFileSync(f('n.txt'), 'plain');
fs.mkdirSync(f('d.md'));
fs.writeFileSync(f('secret.md'), 'secret');
fs.symlinkSync(f('secret.md'), f('link.md'));

test('checkPathShape wants absolute, normalised, NUL-free strings', () => {
  assert.equal(checkPathShape('/a/b.md'), true);
  for (const p of ['a.md', '~/a.md', '/a/../b.md', '/a//b.md', '/a/b.md/', '/a\0.md', '', null, 7]) assert.equal(checkPathShape(p), false, String(p));
});

test('allow accepts only valid, viewable paths and says so', () => {
  const r = createExtFiles();
  assert.equal(r.allow('x', f('a.md')), true);
  assert.equal(r.allow('x', f('n.txt')), false);
  assert.equal(r.allow('x', 'rel.md'), false);
  assert.equal(r.has('x', f('a.md')), true);
  assert.equal(r.has('y', f('a.md')), false);
  assert.equal(r.forget('x', f('a.md')), true);
  assert.equal(r.has('x', f('a.md')), false);
});

test('allow evicts the oldest past the cap and clear drops an extension', () => {
  const r = createExtFiles({ max: 2 });
  r.allow('x', '/1.md'); r.allow('x', '/2.md'); r.allow('x', '/3.md');
  assert.deepEqual(['/1.md', '/2.md', '/3.md'].map((p) => r.has('x', p)), [false, true, true]);
  r.clear('x');
  assert.equal(r.has('x', '/3.md'), false);
});

test('open reads an allowed markdown file and an allowed image', async () => {
  const r = createExtFiles();
  r.allow('x', f('a.md')); r.allow('x', f('p.png'));
  assert.deepEqual(await r.open('x', f('a.md')), { ok: true, path: f('a.md'), kind: 'markdown', mime: 'text/markdown', size: 7, text: '# Hello' });
  const img = await r.open('x', f('p.png'));
  assert.equal(img.ok, true);
  assert.equal(img.mime, 'image/png');
  assert.equal(Buffer.from(img.base64, 'base64').equals(PNG), true);
});

test('open refuses with a reason and never throws', async () => {
  const r = createExtFiles();
  r.allow('x', f('a.md')); r.allow('x', f('link.md')); r.allow('x', f('d.md')); r.allow('x', f('gone.md'));
  const reason = async (id, p) => (await r.open(id, p)).reason;
  assert.equal(await reason('x', 'a.md'), 'invalid-path');
  assert.equal(await reason('x', 42), 'invalid-path');
  assert.equal(await reason('x', f('n.txt')), 'unsupported-type');
  assert.equal(await reason('x', f('secret.md')), 'not-permitted');
  assert.equal(await reason('other', f('a.md')), 'not-permitted');
  assert.equal(await reason('x', f('gone.md')), 'not-found');
  assert.equal(await reason('x', f('link.md')), 'changed');
  assert.equal(await reason('x', f('d.md')), 'not-a-file');
});

test('a symlink swapped in after registration is refused, for the file and for a parent', async () => {
  const r = createExtFiles();
  fs.mkdirSync(f('sub'));
  fs.writeFileSync(f('sub/s.md'), 'one');
  fs.writeFileSync(f('swap.md'), 'one');
  r.allow('x', f('swap.md')); r.allow('x', f('sub/s.md'));
  assert.equal((await r.open('x', f('swap.md'))).ok, true);
  fs.rmSync(f('swap.md'));
  fs.symlinkSync(f('secret.md'), f('swap.md'));
  assert.equal((await r.open('x', f('swap.md'))).reason, 'changed');
  fs.mkdirSync(f('elsewhere'));
  fs.writeFileSync(f('elsewhere/s.md'), 'two');
  fs.renameSync(f('sub'), f('sub-old'));
  fs.symlinkSync(f('elsewhere'), f('sub'));
  assert.equal((await r.open('x', f('sub/s.md'))).reason, 'changed');
});

test('a file over its kind cap is too-large', async () => {
  fs.writeFileSync(f('big.md'), Buffer.alloc(FILE_KIND_LIMITS.markdown + 1, 97));
  assert.deepEqual(await readSafeFile(f('big.md')), { ok: false, reason: 'too-large' });
});
