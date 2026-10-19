import test from 'node:test';
import assert from 'node:assert/strict';
import { fileTypeOf, canOpenPath, fileTypes } from './file-types.js';

test('markdown and image extensions map to a kind and a derived mime, case-insensitively', () => {
  assert.deepEqual({ ...fileTypeOf('/a/b.md') }, { kind: 'markdown', mime: 'text/markdown' });
  assert.equal(fileTypeOf('/a/B.MARKDOWN').kind, 'markdown');
  assert.equal(fileTypeOf('/a/p.PNG').mime, 'image/png');
  assert.equal(fileTypeOf('/a/p.jpg').mime, 'image/jpeg');
  assert.equal(fileTypeOf('/a/p.jpeg').mime, 'image/jpeg');
});

test('canOpen is true for .md and false for .txt, .svg, dotfiles, extensionless and non-strings', () => {
  assert.equal(canOpenPath('/x/notes.md'), true);
  for (const p of ['/x/notes.txt', '/x/i.svg', '/x/.md', '/x/md', '/x.md/readme', '', null, undefined, 42, '/x/__proto__']) {
    assert.equal(canOpenPath(p), false, String(p));
  }
});

test('types() lists every extension once and hands out a fresh copy', () => {
  const t = fileTypes();
  assert.deepEqual(t.map((x) => x.ext).sort(), ['.gif', '.jpeg', '.jpg', '.markdown', '.md', '.png', '.webp']);
  t[0].kind = 'x';
  assert.notEqual(fileTypes()[0].kind, 'x');
  assert.ok(t.every((x) => canOpenPath(`/f${x.ext}`)));
});
