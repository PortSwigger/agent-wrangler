import { test } from 'node:test';
import assert from 'node:assert/strict';

// diff-dom.js builds DOM via the global `document`, so install a minimal stub
// BEFORE importing it. The stub is deliberate about the one property this test
// cares about: textContent stores a plain string and clears children — it never
// parses markup — which is exactly the XSS-safe behaviour we're asserting. Only a
// trusted constant icon is allowed to reach innerHTML.
function makeDoc() {
  const mkEl = (tag) => ({
    tagName: String(tag).toUpperCase(),
    className: '',
    dataset: {},
    style: {},
    _attrs: {},
    childNodes: [],
    _text: '',
    _isFragment: false,
    _innerHTML: '',
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    append(...nodes) {
      for (const n of nodes) {
        if (n && n._isFragment) { this.childNodes.push(...n.childNodes); n.childNodes = []; }
        else this.childNodes.push(n);
      }
    },
    get textContent() {
      return this.childNodes.length ? this.childNodes.map((c) => c.textContent).join('') : this._text;
    },
    set textContent(v) { this._text = String(v); this.childNodes = []; },
    set innerHTML(v) { this._innerHTML = String(v); },
    get innerHTML() { return this._innerHTML; },
  });
  return {
    createElement: (t) => mkEl(t),
    createTextNode: (t) => ({ tagName: '#text', childNodes: [], _t: String(t), get textContent() { return this._t; } }),
    createDocumentFragment: () => { const f = mkEl('#fragment'); f._isFragment = true; return f; },
  };
}
globalThis.document = makeDoc();

const { fileHeaderEl, hunkHeadEl, lineEl, draftBlockEl, noticeEl, editorEl, fileListEl, orderFilesForDisplay } = await import('./diff-dom.js');

// Recursively find the first element node carrying `cls` in its className.
function byClass(node, cls) {
  for (const c of node.childNodes || []) {
    if (typeof c.className === 'string' && c.className.split(' ').includes(cls)) return c;
    const deep = byClass(c, cls);
    if (deep) return deep;
  }
  return null;
}
// Count of element (non-text) children anywhere under a node.
function elementCount(node) {
  let n = 0;
  for (const c of node.childNodes || []) { if (c.tagName !== '#text') n += 1; n += elementCount(c); }
  return n;
}

const XSS = '<img src=x onerror="alert(1)">';

test('lineEl: hostile line text lands as inert textContent, never markup', () => {
  const frag = lineEl('src/a.js', { type: 'add', text: XSS, oldLine: null, newLine: 7 }, {});
  const row = frag.childNodes[0];
  const textEl = byClass(row, 'diff-text');
  assert.ok(textEl, '.diff-text present');
  // The exact payload survives as a single text value — the browser would render
  // it as visible text, not an <img> that fires onerror.
  assert.equal(textEl.textContent, XSS);
  assert.equal(elementCount(textEl), 0, 'no parsed child elements from the payload');
  assert.equal(textEl.innerHTML, '', 'never routed through innerHTML');
  // Line addressing still rides in data-* (used by the comment delegation).
  assert.equal(row.dataset.file, 'src/a.js');
  assert.equal(row.dataset.side, 'new');
  assert.equal(row.dataset.line, '7');
});

test('lineEl: a single-line draft anchored on the line is its immediate next sibling', () => {
  const drafts = { 'src/a.js|new|7|7': { file: 'src/a.js', side: 'new', startLine: 7, endLine: 7, body: 'why <b>this</b>?' } };
  const frag = lineEl('src/a.js', { type: 'add', text: 'ok', oldLine: null, newLine: 7 }, drafts);
  assert.equal(frag.childNodes.length, 2, 'line row + draft block');
  const draft = frag.childNodes[1];
  assert.ok(draft.className.includes('diff-draft'));
  const body = byClass(draft, 'diff-draft-text');
  assert.equal(body.textContent, 'why <b>this</b>?'); // inert, not parsed
  assert.equal(elementCount(body), 0);
});

test('lineEl: a RANGE draft is emitted only under the last line of its span, with a span label', () => {
  const drafts = { 'src/a.js|new|5|7': { file: 'src/a.js', side: 'new', startLine: 5, endLine: 7, body: 'span note' } };
  // The middle/start line (6) carries no draft block…
  const mid = lineEl('src/a.js', { type: 'context', text: 'm', oldLine: 6, newLine: 6 }, drafts);
  assert.equal(mid.childNodes.length, 1, 'no draft under a non-anchor line');
  // …but the end line (7) anchors it.
  const end = lineEl('src/a.js', { type: 'add', text: 'e', oldLine: null, newLine: 7 }, drafts);
  assert.equal(end.childNodes.length, 2, 'draft block hangs under the end line');
  const loc = byClass(end.childNodes[1], 'diff-draft-loc');
  assert.equal(loc.textContent, 'Lines 5–7');
});

test('lineEl: selectedKeys tints a line in the range with .selected (single lines are not tinted)', () => {
  const sel = new Set(['src/a.js|new|7']);
  const inRange = lineEl('src/a.js', { type: 'add', text: 'e', oldLine: null, newLine: 7 }, {}, sel);
  assert.ok(inRange.childNodes[0].className.includes('selected'));
  const outRange = lineEl('src/a.js', { type: 'add', text: 'e', oldLine: null, newLine: 8 }, {}, sel);
  assert.ok(!outRange.childNodes[0].className.includes('selected'));
});

test('draftBlockEl: body text with markup stays inert; a range shows its span label', () => {
  const d = draftBlockEl('k', { file: 'a', side: 'new', startLine: 3, endLine: 9, body: XSS });
  const body = byClass(d, 'diff-draft-text');
  assert.equal(body.textContent, XSS);
  assert.equal(elementCount(body), 0);
  assert.equal(byClass(d, 'diff-draft-loc').textContent, 'Lines 3–9');
});

test('editorEl: a hostile side value lands as inert text in the span label and placeholder', () => {
  const ed = editorEl('<x>', 12, 18);
  assert.equal(byClass(ed, 'diff-editor-loc').textContent, 'Lines 12–18 (<x>)');
  assert.equal(elementCount(byClass(ed, 'diff-editor-loc')), 0);
});

test('fileHeaderEl: a hostile path is inert text; badge carries the status label', () => {
  const head = fileHeaderEl({ status: 'untracked', path: XSS });
  const p = byClass(head, 'diff-file-path');
  assert.equal(p.textContent, XSS);
  assert.equal(elementCount(p), 0);
  const badge = byClass(head, 'diff-badge');
  assert.equal(badge.textContent, 'untracked');
});

test('fileHeaderEl: a rename shows old → new with both paths inert', () => {
  const head = fileHeaderEl({ status: 'renamed', oldPath: 'a<x>.js', path: 'b<y>.js' });
  const p = byClass(head, 'diff-file-path');
  assert.equal(p.textContent, 'a<x>.js→b<y>.js'); // text nodes + the arrow span's "→"
  assert.ok(byClass(p, 'diff-arrow'), 'arrow separator present');
});

test('fileListEl: files sharing a folder get one dir header, rows show basenames indented deeper', () => {
  const files = [
    { status: 'modified', path: 'src/a.js' },
    { status: 'added', path: 'src/b.js' },
  ];
  const frag = fileListEl(files);
  assert.equal(frag.childNodes.length, 3, 'one dir header + two file rows');
  const [dir, row1, row2] = frag.childNodes;
  assert.ok(dir.className.includes('diff-filelist-dir'));
  assert.equal(dir.textContent, 'src');
  assert.ok(row1.className.includes('diff-filelist-row'));
  assert.equal(row1.dataset.file, 'src/a.js');
  assert.equal(byClass(row1, 'diff-file-path').textContent, 'a.js', 'label is the basename, not the full path');
  const dot1 = byClass(row1, 'diff-dot');
  assert.equal(dot1.className, 'diff-dot diff-dot-modified');
  assert.equal(dot1.title, 'modified');
  assert.equal(dot1.getAttribute('aria-label'), 'modified');
  assert.equal(row2.dataset.file, 'src/b.js');
  assert.equal(byClass(row2, 'diff-dot').className, 'diff-dot diff-dot-added');
  // Files are indented one level deeper than the dir header that names their folder.
  const dirIndent = parseInt(dir.style.paddingLeft, 10);
  const rowIndent = parseInt(row1.style.paddingLeft, 10);
  assert.ok(rowIndent > dirIndent, `row indent (${rowIndent}) should exceed dir indent (${dirIndent})`);
});

test('fileListEl: a root-level file gets no dir header and sits at the base indent', () => {
  const frag = fileListEl([{ status: 'untracked', path: 'PLAN.md' }]);
  assert.equal(frag.childNodes.length, 1);
  const row = frag.childNodes[0];
  assert.equal(byClass(row, 'diff-file-path').textContent, 'PLAN.md');
  assert.equal(row.style.paddingLeft, '12px');
});

test('fileListEl: a chain of single-child dirs compacts into one "a/b" header (GitHub-style)', () => {
  const frag = fileListEl([{ status: 'modified', path: 'a/b/c.js' }]);
  const dirNames = frag.childNodes.filter((n) => n.className.includes('diff-filelist-dir')).map((n) => n.textContent);
  assert.deepEqual(dirNames, ['a/b'], 'a has only one child (b) and no files of its own, so it compacts');
  const row = frag.childNodes.find((n) => n.className.includes('diff-filelist-row'));
  assert.equal(byClass(row, 'diff-file-path').textContent, 'c.js');
  // Only one rendered depth level (the combined "a/b" header), so the file is
  // indented just one level in, not two.
  assert.equal(row.style.paddingLeft, `${12 + 14}px`);
});

test('fileListEl: compaction stops at a branch point, continuing separately down each side', () => {
  // foo/bar/wibble/numpty/hello.txt and foo/bar/bingo/bango/goodbye.txt: foo and
  // bar each have exactly one child, so they compact into "foo/bar"; bar's TWO
  // children (wibble, bingo) is a branch, so compaction restarts independently
  // down each one.
  const frag = fileListEl([
    { status: 'modified', path: 'foo/bar/wibble/numpty/hello.txt' },
    { status: 'modified', path: 'foo/bar/bingo/bango/goodbye.txt' },
  ]);
  const dirNames = frag.childNodes.filter((n) => n.className.includes('diff-filelist-dir')).map((n) => n.textContent);
  assert.deepEqual(dirNames, ['foo/bar', 'wibble/numpty', 'bingo/bango']);
  const fileNames = frag.childNodes.filter((n) => n.className.includes('diff-filelist-row')).map((n) => byClass(n, 'diff-file-path').textContent);
  assert.deepEqual(fileNames, ['hello.txt', 'goodbye.txt']);
});

test('fileListEl: a dir holding both a file and a subdir does not compact past itself', () => {
  const frag = fileListEl([
    { status: 'modified', path: 'a/direct.js' },
    { status: 'modified', path: 'a/b/nested.js' },
  ]);
  const dirNames = frag.childNodes.filter((n) => n.className.includes('diff-filelist-dir')).map((n) => n.textContent);
  assert.deepEqual(dirNames, ['a', 'b'], 'a has a file of its own, so merging past it would hide that');
});

test('fileListEl: a rename carries "old → new" in the title, but the label is just the new basename', () => {
  const frag = fileListEl([{ status: 'renamed', oldPath: 'old/old<x>.js', path: 'new/new<y>.js' }]);
  const row = frag.childNodes.find((n) => n.className.includes('diff-filelist-row'));
  assert.equal(row.title, 'old/old<x>.js → new/new<y>.js');
  assert.equal(byClass(row, 'diff-file-path').textContent, 'new<y>.js');
});

test('orderFilesForDisplay: matches fileListEl\'s dirs-before-files order, not raw input order', () => {
  // Raw order is a flat alphabetical sort (as git diff would produce): a root
  // file (CLAUDE.md) sorts before "public"/"server" despite the nav grouping
  // folders first — the diff body must render in the SAME order as the nav or
  // scrolling moves through it non-monotonically.
  const files = [
    { status: 'modified', path: 'CLAUDE.md' },
    { status: 'modified', path: 'public/a.js' },
    { status: 'modified', path: 'server/b.js' },
  ];
  const ordered = orderFilesForDisplay(files);
  assert.deepEqual(ordered.map((f) => f.path), ['public/a.js', 'server/b.js', 'CLAUDE.md']);
});

test('hunkHeadEl / noticeEl: content is inert textContent', () => {
  assert.equal(hunkHeadEl('@@ -1 +1 @@ <script>').textContent, '@@ -1 +1 @@ <script>');
  const n = noticeEl('boom <img>', 'diff-notice-error');
  assert.equal(n.textContent, 'boom <img>');
  assert.equal(n.className, 'diff-notice diff-notice-error');
  assert.equal(elementCount(n), 0);
});
