import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandHome, isMarkdownPath, resolveMarkdownPath } from './file-preview.js';

test('expandHome expands ~ and ~/…', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u');
  assert.equal(expandHome('~/a/b.md', '/home/u'), '/home/u/a/b.md');
  assert.equal(expandHome('/x/y.md', '/home/u'), '/x/y.md');
});

test('isMarkdownPath accepts .md/.markdown case-insensitively, rejects others', () => {
  assert.ok(isMarkdownPath('/a/b.md'));
  assert.ok(isMarkdownPath('/a/b.MARKDOWN'));
  assert.ok(!isMarkdownPath('/a/b.txt'));
});

// Injected fake fs: keys are the resolved (post-realpath) targets.
function fakeDeps() {
  const real = {
    '/home/u/a.md': '/home/u/a.md', '/l.md': '/target.txt',
    '/big.md': '/big.md', '/dir.md': '/dir.md', '/vanish.md': '/vanish.md',
  };
  return {
    homedir: '/home/u',
    realpathSync: (p) => { if (p in real) return real[p]; const e = new Error('ENOENT'); throw e; },
    statSync: (p) => {
      if (p === '/vanish.md') throw new Error('ENOENT');
      return { size: p === '/big.md' ? 3_000_000 : 42, isFile: () => p !== '/dir.md' };
    },
    maxBytes: 2 * 1024 * 1024,
  };
}

test('resolves a real .md file to 200 + resolved path', () => {
  assert.deepEqual(resolveMarkdownPath('~/a.md', fakeDeps()), { status: 200, path: '/home/u/a.md' });
});
test('415 when the symlink target is not markdown', () => {
  assert.equal(resolveMarkdownPath('/l.md', fakeDeps()).status, 415);
});
test('404 when the path does not exist', () => {
  assert.equal(resolveMarkdownPath('/nope.md', fakeDeps()).status, 404);
});
test('413 when the file exceeds the size cap', () => {
  assert.equal(resolveMarkdownPath('/big.md', fakeDeps()).status, 413);
});
test('415 when the resolved target is a directory / not a regular file', () => {
  assert.equal(resolveMarkdownPath('/dir.md', fakeDeps()).status, 415);
});
test('404 when stat throws after realpath succeeds (file vanished)', () => {
  assert.equal(resolveMarkdownPath('/vanish.md', fakeDeps()).status, 404);
});
test('400 on null/undefined raw path', () => {
  assert.equal(resolveMarkdownPath(null, fakeDeps()).status, 400);
  assert.equal(resolveMarkdownPath(undefined, fakeDeps()).status, 400);
});
test('400 on a relative / empty path', () => {
  assert.equal(resolveMarkdownPath('foo.md', fakeDeps()).status, 400);
  assert.equal(resolveMarkdownPath('', fakeDeps()).status, 400);
});
