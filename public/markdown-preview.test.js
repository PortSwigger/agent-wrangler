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

// ── input coercion ──────────────────────────────────────────────────────────────
test('renders empty string for null/undefined source', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});
