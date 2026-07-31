import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMarkdownPaths, createMarkdownLinkProvider, resolveTerminalPath } from './term-links.js';

test('matches an absolute .md path', () => {
  assert.deepEqual(findMarkdownPaths('see /tmp/foo/notes.md now'), ['/tmp/foo/notes.md']);
});
test('matches a ~ home path and .markdown extension', () => {
  assert.deepEqual(findMarkdownPaths('~/docs/plan.markdown'), ['~/docs/plan.markdown']);
});
test('trims trailing sentence punctuation', () => {
  assert.deepEqual(findMarkdownPaths('open /a/b.md.'), ['/a/b.md']);
  assert.deepEqual(findMarkdownPaths('(/a/b.md)'), ['/a/b.md']);
});
test('finds multiple paths on one line', () => {
  assert.deepEqual(findMarkdownPaths('/a.md and /b/c.md'), ['/a.md', '/b/c.md']);
});
test('ignores http(s) URLs (WebLinksAddon owns those)', () => {
  assert.deepEqual(findMarkdownPaths('https://example.com/x/y.md'), []);
  // A URL embedded in prose stays excluded even though its sub-path (docs/plan.md)
  // looks like a relative match — the lookbehind blocks every interior segment.
  assert.deepEqual(findMarkdownPaths('see https://x.io/docs/plan.md here'), []);
});
test('ignores non-markdown paths and .mdx / .md.bak lookalikes', () => {
  assert.deepEqual(findMarkdownPaths('/a/b.txt /c/d.mdx /e/f.md.bak'), []);
});
test('matches a relative path that has a directory separator', () => {
  assert.deepEqual(findMarkdownPaths('docs/superpowers/specs/x-design.md'), ['docs/superpowers/specs/x-design.md']);
  assert.deepEqual(findMarkdownPaths('./notes.md'), ['./notes.md']);
  assert.deepEqual(findMarkdownPaths('../plan.md'), ['../plan.md']);
  assert.deepEqual(findMarkdownPaths('a/b/c.md'), ['a/b/c.md']);
});
test('ignores a bare filename with no directory separator', () => {
  // A lone `word.md` is too ambiguous to linkify (prose mentions README.md etc.);
  // a slash is the required "this is a path" signal.
  assert.deepEqual(findMarkdownPaths('README.md'), []);
  assert.deepEqual(findMarkdownPaths('see foo.md here'), []);
});

// ── link provider coordinate mapping (fake xterm buffer) ─────────────────────
// A hand-built buffer so the wrapped-line + wide-char coord math is locked in
// without a browser. Each row is { wrapped, cells:[{c,w}] }; blank cols pad width-1.
function makeTerm(rows, cols) {
  const getLine = (i) => {
    const r = rows[i];
    if (!r) return undefined;
    return {
      isWrapped: !!r.wrapped,
      getCell: (col) => {
        const cell = r.cells[col];
        return cell
          ? { getChars: () => cell.c, getWidth: () => cell.w }
          : { getChars: () => '', getWidth: () => 1 };
      },
    };
  };
  return { cols, buffer: { active: { getLine } } };
}
const cellsOf = (s) => [...s].map((c) => ({ c, w: 1 }));
function linksFor(term, y, baseDir) {
  let out;
  createMarkdownLinkProvider(term, () => {}, baseDir).provideLinks(y, (l) => { out = l; });
  return out;
}

test('provider: single-line path gets a 1-based inclusive range', () => {
  const term = makeTerm([{ cells: cellsOf('see /tmp/a.md') }], 20);
  const links = linksFor(term, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '/tmp/a.md');
  assert.deepEqual(links[0].range, { start: { x: 5, y: 1 }, end: { x: 13, y: 1 } });
});

test('provider: activate passes the matched path', () => {
  const term = makeTerm([{ cells: cellsOf('/x.md') }], 10);
  let got;
  createMarkdownLinkProvider(term, (u) => { got = u; }).provideLinks(1, (l) => l[0].activate());
  assert.equal(got, '/x.md');
});

test('provider: a wrapped path maps end coords onto the continuation row', () => {
  const term = makeTerm([
    { cells: cellsOf('/aa/b') },
    { wrapped: true, cells: cellsOf('b.md') },
  ], 5);
  const links = linksFor(term, 2); // hover the continuation row
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '/aa/bb.md');
  assert.deepEqual(links[0].range, { start: { x: 1, y: 1 }, end: { x: 4, y: 2 } });
});

test('provider: a preceding wide char shifts the column by its display width', () => {
  const term = makeTerm([{ cells: [{ c: '北', w: 2 }, { c: '', w: 0 }, ...cellsOf('/x.md')] }], 10);
  const links = linksFor(term, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '/x.md');
  assert.deepEqual(links[0].range, { start: { x: 3, y: 1 }, end: { x: 7, y: 1 } });
});

test('provider: no matches → callback receives undefined', () => {
  const term = makeTerm([{ cells: cellsOf('no paths here') }], 20);
  assert.equal(linksFor(term, 1), undefined);
});

// ── relative-path resolution ─────────────────────────────────────────────────
test('resolveTerminalPath: absolute and ~ pass through untouched', () => {
  assert.equal(resolveTerminalPath('/abs/x.md', '/base'), '/abs/x.md');
  assert.equal(resolveTerminalPath('~/x.md', '/base'), '~/x.md');
});
test('resolveTerminalPath: a relative match is joined onto baseDir', () => {
  assert.equal(resolveTerminalPath('docs/x.md', '/repo'), '/repo/docs/x.md');
  assert.equal(resolveTerminalPath('./notes.md', '/repo'), '/repo/./notes.md'); // server realpath normalizes
  assert.equal(resolveTerminalPath('../plan.md', '/repo/sub'), '/repo/sub/../plan.md');
});
test('resolveTerminalPath: trailing slash on baseDir is not doubled', () => {
  assert.equal(resolveTerminalPath('docs/x.md', '/repo/'), '/repo/docs/x.md');
});
test('resolveTerminalPath: a relative match with no baseDir returns null', () => {
  assert.equal(resolveTerminalPath('docs/x.md', undefined), null);
  assert.equal(resolveTerminalPath('docs/x.md', ''), null);
});

test('provider: a relative path resolves against baseDir for activate', () => {
  const term = makeTerm([{ cells: cellsOf('edit docs/plan.md now') }], 30);
  let got;
  createMarkdownLinkProvider(term, (u) => { got = u; }, '/repo')
    .provideLinks(1, (l) => l[0].activate());
  assert.equal(got, '/repo/docs/plan.md');
  // The underlined text stays the on-screen match, not the resolved path.
  const links = linksFor(term, 1, '/repo');
  assert.equal(links[0].text, 'docs/plan.md');
});
test('provider: a relative path with no baseDir yields no link', () => {
  const term = makeTerm([{ cells: cellsOf('edit docs/plan.md now') }], 30);
  assert.equal(linksFor(term, 1, undefined), undefined);
});
test('provider: an absolute path still links even with no baseDir', () => {
  const term = makeTerm([{ cells: cellsOf('edit /repo/plan.md now') }], 30);
  const links = linksFor(term, 1, undefined);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '/repo/plan.md');
});
