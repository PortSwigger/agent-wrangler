import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSegments, linkedHtml, trimUrlTail, urlRegex, MD_LINK_CLASS } from './text-links.js';

const kinds = (segs) => segs.map((s) => `${s.kind}:${s.text}`);

// ── URLs ───────────────────────────────────────────────────────────────────────
test('a bare http(s) URL in prose becomes one url segment', () => {
  assert.deepEqual(
    kinds(linkSegments('check https://example.com/a?b=1 now')),
    ['text:check ', 'url:https://example.com/a?b=1', 'text: now'],
  );
});

test('a scheme-less host is left alone — prose is likelier than a link', () => {
  assert.deepEqual(kinds(linkSegments('see example.com/a for more')), ['text:see example.com/a for more']);
});

test('sentence punctuation and a wrapping bracket stay out of the href', () => {
  assert.equal(trimUrlTail('https://example.com/a.'), 'https://example.com/a');
  assert.equal(trimUrlTail('https://example.com/a),'), 'https://example.com/a');
  assert.equal(trimUrlTail('https://example.com/a"'), 'https://example.com/a');
});

test("a bracket the URL opened itself is kept — it is part of the address", () => {
  assert.equal(trimUrlTail('https://en.wikipedia.org/wiki/X_(y)'), 'https://en.wikipedia.org/wiki/X_(y)');
});

test('a trimmed-to-nothing match yields no link at all', () => {
  assert.equal(trimUrlTail('https://'), '');
  assert.equal(trimUrlTail('https://.'), '');
});

test('the URL match starts at a token boundary, not mid-word', () => {
  assert.deepEqual('xhttps://example.com'.match(urlRegex()), null);
});

// ── markdown paths ─────────────────────────────────────────────────────────────
test('a relative .md path resolves against the session cwd', () => {
  const segs = linkSegments('wrote docs/plan.md', { baseDir: '/repo' });
  assert.deepEqual(kinds(segs), ['text:wrote ', 'file:docs/plan.md']);
  assert.equal(segs[1].path, '/repo/docs/plan.md');
});

test('an absolute or ~ path needs no cwd', () => {
  assert.equal(linkSegments('see /a/b.md', { baseDir: null })[1].path, '/a/b.md');
  assert.equal(linkSegments('see ~/notes.md', { baseDir: null })[1].path, '~/notes.md');
});

// The same refusal term-links.js's xterm provider makes: with nothing to resolve
// against, a relative path would have to be invented, so it stays plain text.
test('a relative path with no cwd stays text rather than pointing somewhere invented', () => {
  assert.deepEqual(kinds(linkSegments('wrote docs/plan.md', { baseDir: null })), ['text:wrote docs/plan.md']);
});

test('a URL that happens to end in .md is a URL, not a file path', () => {
  const segs = linkSegments('https://example.com/docs/plan.md', { baseDir: '/repo' });
  assert.deepEqual(kinds(segs), ['url:https://example.com/docs/plan.md']);
});

// The URL body stops at whitespace, so a trimmed tail can reopen the gap the path
// regex's own lookbehind was relying on. The overlap check is what closes it.
test('a path is never emitted inside a URL span', () => {
  for (const seg of linkSegments('(https://example.com/a/b.md)', { baseDir: '/repo' })) {
    assert.notEqual(seg.kind, 'file');
  }
});

test('urls:false suppresses URL matching for markdown prose, where linkify already ran', () => {
  assert.deepEqual(
    kinds(linkSegments('see https://example.com and docs/a.md', { baseDir: '/r', urls: false })),
    ['text:see https://example.com and ', 'file:docs/a.md'],
  );
});

test('empty and non-string input yield a single empty text segment', () => {
  assert.deepEqual(linkSegments(''), [{ kind: 'text', text: '' }]);
  assert.deepEqual(linkSegments(null), [{ kind: 'text', text: '' }]);
});

// ── HTML emitter ───────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('every segment goes through escapeHtml, plain runs included', () => {
  const html = linkedHtml('<b>x</b> docs/a.md', { baseDir: '/r', escapeHtml: esc });
  assert.ok(!html.includes('<b>'), 'the raw tag is escaped');
  assert.ok(html.includes(`class="${MD_LINK_CLASS}"`));
  assert.ok(html.includes('data-md-path="/r/docs/a.md"'));
});

test('a URL segment renders an anchor with the tabnabbing guard', () => {
  const html = linkedHtml('https://example.com', { urls: true, escapeHtml: esc });
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">/);
});
