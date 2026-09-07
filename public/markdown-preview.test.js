import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRenderer } from './markdown-preview.js';

// Load the vendored markdown-it UMD the same way the browser's classic <script>
// does — by executing it for its side effect of assigning module.exports. We
// can't `createRequire(...)('./vendor/markdown-it.min.js')`: this package is
// "type": "module", so require() resolves a .js as ESM and a UMD bundle exposes
// no ESM exports (empty namespace). A bare CommonJS vm context gives the UMD the
// `module`/`exports` it probes for, yielding the markdownit factory.
const umd = readFileSync(fileURLToPath(new URL('./vendor/markdown-it.min.js', import.meta.url)), 'utf8');
const mod = { exports: {} };
vm.runInNewContext(umd, { module: mod, exports: mod.exports });
const markdownit = mod.exports;

const render = createRenderer(markdownit);

// ── basic markdown ─────────────────────────────────────────────────────────────
test('renders an ATX heading as <h1>', () => {
  assert.match(render('# Title'), /<h1>Title<\/h1>/);
});
test('renders **bold** as <strong>', () => {
  assert.match(render('**bold**'), /<strong>bold<\/strong>/);
});
test('renders a GFM table as <table> (tables on by default)', () => {
  const html = render('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
});

// ── safe-by-default: no raw HTML, no unsafe schemes ─────────────────────────────
test('escapes raw HTML — neither lower- nor upper-case <script> survives (html:false)', () => {
  // String checks, not a /<script>/ regex: a tag-matching regex here trips CodeQL's
  // js/bad-tag-filter (it reads the test as a sanitizer and flags that it misses
  // <SCRIPT>) — yet the real escaping is markdown-it's html:false, not this assert.
  // The positive &lt;script&gt; check confirms the tag was neutralised; the
  // case-insensitive includes() also covers the uppercase variant CodeQL worried about.
  const lower = render('<script>alert(1)</script>');
  const upper = render('<SCRIPT>alert(1)</SCRIPT>');
  assert.match(lower, /&lt;script&gt;/);
  assert.ok(!lower.toLowerCase().includes('<script'));
  assert.ok(!upper.toLowerCase().includes('<script'));
});
test('drops a javascript: link target — no live href', () => {
  assert.doesNotMatch(render('[x](javascript:alert(1))'), /href="javascript:/i);
});

// ── link handling ──────────────────────────────────────────────────────────────
test('external http(s) link opens in a new tab with rel guard', () => {
  const html = render('[site](https://example.com)');
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
test('relative / in-repo link is left untouched (no target/rel)', () => {
  const html = render('[a](src/token.js)');
  assert.match(html, /href="src\/token\.js"/);
  assert.doesNotMatch(html, /target=/);
  assert.doesNotMatch(html, /rel=/);
});

// ── markdown-file links (chat view only: mdPathBase supplied) ─────────────────
const mdRender = createRenderer(markdownit, { mdPathBase: () => '/repo' });

test('a bare .md path in prose becomes a preview control', () => {
  const html = mdRender('wrote docs/plan.md');
  assert.match(html, /<a class="md-file-link" role="button" tabindex="0" data-md-path="\/repo\/docs\/plan\.md" title="\/repo\/docs\/plan\.md">docs\/plan\.md<\/a>/);
});

// Backticked paths are how an agent normally writes one, so this is the common
// case rather than an edge — and it is what the terminal view already linkifies.
test('a .md path inside inline code becomes a preview control too', () => {
  const html = mdRender('see `docs/plan.md`');
  assert.match(html, /<code><a class="md-file-link"/);
});

// A fenced block is content to copy verbatim; an inline control in it fights both
// the block styling and a drag-select.
test('a fenced code block is left verbatim', () => {
  const html = mdRender('```\ncat docs/plan.md\n```');
  assert.doesNotMatch(html, /md-file-link/);
  assert.match(html, /cat docs\/plan\.md/);
});

test('a markdown link to a local .md file loses its href and becomes a preview control', () => {
  const html = mdRender('[the plan](docs/plan.md)');
  assert.match(html, /<a class="md-file-link" role="button" tabindex="0" data-md-path="\/repo\/docs\/plan\.md" title="\/repo\/docs\/plan\.md">the plan<\/a>/);
  // The href is what would navigate the board away from the app.
  assert.doesNotMatch(html, /href=/);
});

test('a fragment on a local .md link is dropped — the modal renders whole files', () => {
  assert.match(mdRender('[x](docs/plan.md#setup)'), /data-md-path="\/repo\/docs\/plan\.md"/);
});

test('a link to a non-markdown file is left as an ordinary relative link', () => {
  const html = mdRender('[a](src/token.js)');
  assert.match(html, /href="src\/token\.js"/);
  assert.doesNotMatch(html, /md-file-link/);
});

// Nesting an anchor inside an anchor is invalid, and the inner control would eat
// the click meant for the outer link.
test('a path in a link label is not turned into a nested control', () => {
  const html = mdRender('[see docs/plan.md here](https://example.com)');
  assert.doesNotMatch(html, /md-file-link/);
  assert.match(html, /target="_blank"/);
});

test('a relative path stays plain when the session has no cwd to resolve against', () => {
  const html = createRenderer(markdownit, { mdPathBase: () => null })('wrote docs/plan.md');
  assert.doesNotMatch(html, /md-file-link/);
});

test('an absolute .md path needs no cwd', () => {
  const html = createRenderer(markdownit, { mdPathBase: () => null })('wrote /a/b.md');
  assert.match(html, /data-md-path="\/a\/b\.md"/);
});

// The memory preview pane passes no mdPathBase, so it renders exactly as before.
test('without mdPathBase nothing is linkified and raw HTML is still escaped', () => {
  const html = render('wrote docs/plan.md with <b>x</b>');
  assert.doesNotMatch(html, /md-file-link/);
  assert.match(html, /&lt;b&gt;/);
});

test('text around a preview control is still escaped', () => {
  assert.match(mdRender('<b>x</b> docs/plan.md'), /&lt;b&gt;/);
});

// ── input coercion ──────────────────────────────────────────────────────────────
test('renders empty string for null/undefined source', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});
