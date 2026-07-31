import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPrRefs, prUrl, createPrLinkProvider } from './pr-links.js';

test('matches "PR #1027"', () => {
  assert.deepEqual(findPrRefs('opened PR #1027 for review'), ['PR #1027']);
});
test('finds multiple refs on one line', () => {
  assert.deepEqual(findPrRefs('PR #1 supersedes PR #2'), ['PR #1', 'PR #2']);
});
test('ignores a bare "#1027" and "PR#1027" (no space)', () => {
  assert.deepEqual(findPrRefs('see #1027'), []);
  assert.deepEqual(findPrRefs('PR#1027'), []);
});
test('does not match "PR" as the tail of a longer word', () => {
  assert.deepEqual(findPrRefs('SUPR #5'), []);
});
test('rejects a number run followed by letters rather than truncating it', () => {
  assert.deepEqual(findPrRefs('PR #12abc'), []);
});
test('prUrl builds the github pull url', () => {
  assert.equal(prUrl('acme/widgets', '1027'), 'https://github.com/acme/widgets/pull/1027');
});

// ── link provider coordinate mapping (fake xterm buffer) ─────────────────────
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
function linksFor(term, y, slug) {
  let out;
  createPrLinkProvider(term, slug, () => {}).provideLinks(y, (l) => { out = l; });
  return out;
}

test('provider: a ref gets a 1-based inclusive range covering "PR #12"', () => {
  const term = makeTerm([{ cells: cellsOf('see PR #12 now') }], 20);
  const links = linksFor(term, 1, 'a/b');
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'PR #12');
  assert.deepEqual(links[0].range, { start: { x: 5, y: 1 }, end: { x: 10, y: 1 } });
});
test('provider: activate opens the built PR url', () => {
  const term = makeTerm([{ cells: cellsOf('PR #7') }], 10);
  let got;
  createPrLinkProvider(term, 'acme/widgets', (u) => { got = u; }).provideLinks(1, (l) => l[0].activate());
  assert.equal(got, 'https://github.com/acme/widgets/pull/7');
});
test('provider: no matches → callback receives undefined', () => {
  const term = makeTerm([{ cells: cellsOf('nothing here') }], 20);
  assert.equal(linksFor(term, 1, 'a/b'), undefined);
});
