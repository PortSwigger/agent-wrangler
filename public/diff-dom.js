// Safe DOM builders for the session diff view. Diff content — file paths, hunk
// headers and especially line TEXT — is agent/repo-generated code, so it must
// never touch innerHTML: every user value here goes in via textContent / dataset,
// which the browser stores as data, never parses as markup. Kept out of
// diff-view.js (which grabs #diff-body at import) so these builders are
// unit-testable under `node --test` with only a minimal `document` stub — the
// same pure-leaf split as diff.js. Uses the global `document` but never at module
// scope, so importing it in Node doesn't require a DOM.
import { lineSide, lineNumberFor, draftKey, draftAnchoredAt, rangeLabel } from './diff.js';

const STATUS_LABEL = {
  modified: 'modified', added: 'added', deleted: 'deleted',
  renamed: 'renamed', untracked: 'untracked',
};

// Small element helper: tag + class + optional text (text via textContent, so any
// value is inert). Returns the element for further append/attr wiring.
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// A one-line status/notice block (loading, not-a-repo, empty, error, truncated).
export function noticeEl(text, extraClass) {
  return el('div', extraClass ? `diff-notice ${extraClass}` : 'diff-notice', text);
}

// The file header row: path (or "old → new" for a rename) plus a status badge.
export function fileHeaderEl(f) {
  const head = el('div', 'diff-file-head');
  const pathEl = el('span', 'diff-file-path');
  if (f.status === 'renamed' && f.oldPath) {
    pathEl.append(document.createTextNode(f.oldPath), el('span', 'diff-arrow', '→'), document.createTextNode(f.path));
  } else {
    pathEl.textContent = f.path;
  }
  const badge = el('span', `diff-badge diff-badge-${f.status}`, STATUS_LABEL[f.status] || f.status);
  head.append(pathEl, badge);
  return head;
}

// Groups files into a folder tree keyed by their path segments (a rename groups
// under its NEW path — the old path only ever surfaces in the row's tooltip).
function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files || []) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push(f);
  }
  return root;
}

// Indentation is a flat list of rows at varying padding-left — a real nested
// DOM (folder rows containing their children) buys nothing here: the click
// delegation and scroll-highlight scan already work over a flat `.diff-filelist-row`
// list, and this avoids a wrapper element per folder just to hold that padding.
const FILELIST_BASE_PADDING_PX = 12;
const FILELIST_INDENT_PX = 14;

// GitHub-style folder compaction: a chain of dirs each holding nothing but a
// single subdir (no files of their own) reads as one combined "a/b/c" header
// instead of three nested ones — collapses until hitting a branch (a dir with
// 2+ children) or a dir that itself holds files (compacting past one would
// hide that it has files directly in it, not just in a deeper subdir).
function compactDirChain(name, node) {
  const parts = [name];
  while (node.dirs.size === 1 && node.files.length === 0) {
    const [childName, child] = [...node.dirs][0];
    parts.push(childName);
    node = child;
  }
  return { label: parts.join('/'), node };
}

function appendTree(parent, node, depth) {
  const pad = `${FILELIST_BASE_PADDING_PX + depth * FILELIST_INDENT_PX}px`;
  for (const [name, child] of node.dirs) {
    const { label, node: target } = compactDirChain(name, child);
    const dir = el('div', 'diff-filelist-dir', label);
    dir.style.paddingLeft = pad;
    parent.append(dir);
    appendTree(parent, target, depth + 1);
  }
  for (const f of node.files) {
    const row = el('button', 'diff-filelist-row');
    row.type = 'button';
    row.style.paddingLeft = pad;
    row.dataset.file = f.path;
    const name = f.path.slice(f.path.lastIndexOf('/') + 1);
    row.title = f.status === 'renamed' && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    const dot = el('span', `diff-dot diff-dot-${f.status}`);
    dot.title = STATUS_LABEL[f.status] || f.status;
    dot.setAttribute('aria-label', dot.title);
    row.append(el('span', 'diff-file-path', name), dot);
    parent.append(row);
  }
}

// The fullscreen-only file nav: a folder tree of the changed files, one button
// per file (basename + a small status-colored dot — the rail is too narrow for
// fileHeaderEl's full text badge) indented under its directory's header rows.
// A rename's full "old → new" goes in the title tooltip; the visible label is
// just the new file's basename (the folder rows above it already carry the path).
export function fileListEl(files) {
  const frag = document.createDocumentFragment();
  appendTree(frag, buildFileTree(files), 0);
  return frag;
}

function flattenTree(node, out) {
  for (const [, child] of node.dirs) flattenTree(child, out);
  out.push(...node.files);
}

// The SAME dirs-before-files, depth-first order fileListEl renders its rows in,
// as a flat file array — the diff body must render its sections in this order
// too (not `files`' raw git-diff order), or scrolling through the body moves
// through the nav non-monotonically: the nav groups by folder while raw order
// is a flat alphabetical sort by full path, so e.g. a root file like CLAUDE.md
// sorts first in one and last in the other.
export function orderFilesForDisplay(files) {
  const out = [];
  flattenTree(buildFileTree(files), out);
  return out;
}

export function hunkHeadEl(header) {
  return el('div', 'diff-hunk-head', header);
}

export function binaryEl() {
  return el('div', 'diff-binary', 'Binary file changed.');
}

// A saved draft shown under the last line of its span — a span label ("Line 12" /
// "Lines 12–18"), the body, plus edit/delete affordances. The key rides in data-key so
// the delegated click handler can find the owning draft.
export function draftBlockEl(key, draft) {
  const wrap = el('div', 'diff-draft');
  wrap.dataset.key = key;
  const body = el('div', 'diff-draft-body');
  const start = draft.startLine ?? draft.line;
  const end = draft.endLine ?? draft.line;
  if (start != null) body.append(el('div', 'diff-draft-loc', rangeLabel(start, end)));
  body.append(el('div', 'diff-draft-text', draft.body));
  const acts = el('div', 'diff-draft-acts');
  const edit = el('button', 'diff-draft-edit', 'Edit');
  edit.type = 'button'; edit.dataset.key = key;
  const del = el('button', 'diff-draft-del', 'Delete');
  del.type = 'button'; del.dataset.key = key;
  acts.append(edit, del);
  wrap.append(body, acts);
  return wrap;
}

// Drafts orphaned by an agent edit — their line is no longer in the diff, so they'd
// otherwise be invisible yet still counted and still sent. Surface them in their own
// section so the user can see, edit and delete them. Each item carries the same
// data-* addressing a real line row does (key/file/side/line) so the delegated
// edit/delete handlers and openEditor work against it unchanged, and shows the
// snapshot captured at comment time (the line's original text, still meaningful).
// SAFE DOM only — every user value enters via textContent, never innerHTML. Reuses
// existing themed classes (no new CSS): `.diff-hunk-head` header, `.diff-draft`
// card, `.diff-draft-body`/`-acts`/`-edit`/`-del`.
export function detachedSectionEl(detached) {
  const keys = Object.keys(detached || {});
  const sec = el('section', 'diff-file diff-detached');
  sec.append(el('div', 'diff-hunk-head', `Detached comments (${keys.length}) — their line is no longer in the diff`));
  for (const key of keys) {
    const d = detached[key] || {};
    const start = d.startLine ?? d.line;
    const end = d.endLine ?? d.line;
    const span = start == null ? '' : (start === end ? String(start) : `${start}-${end}`);
    const item = el('div', 'diff-draft');
    item.dataset.key = key;
    item.dataset.file = d.file ?? '';
    item.dataset.side = d.side ?? '';
    item.dataset.line = String(start ?? '');
    const col = el('div', 'diff-draft-body');
    const loc = `${d.file ?? ''}:${span}${d.side ? ` (${d.side})` : ''}`;
    const locEl = el('div', 'diff-detached-loc');
    locEl.append(el('strong', null, loc));
    col.append(locEl);
    // The span snapshot can be multi-line — quote each captured line on its own `>`
    // row so a range's original code reads clearly (single line → one row, as before).
    if (d.snapshot) {
      for (const snapLine of String(d.snapshot).split('\n')) {
        col.append(el('div', 'diff-detached-snap', `> ${snapLine}`));
      }
    }
    col.append(el('div', 'diff-detached-text', d.body ?? ''));
    const acts = el('div', 'diff-draft-acts');
    const edit = el('button', 'diff-draft-edit', 'Edit');
    edit.type = 'button'; edit.dataset.key = key;
    const del = el('button', 'diff-draft-del', 'Delete');
    del.type = 'button'; del.dataset.key = key;
    acts.append(edit, del);
    item.append(col, acts);
    sec.append(item);
  }
  return sec;
}

// A single diff line row, followed (in the returned fragment) by a draft block when a
// draft is ANCHORED at this line (its endLine === this line — so a range's draft hangs
// under the last line of the span, a single-line draft under its own line). The click
// delegation relies on that draft being the anchor row's immediate next sibling, which
// append-into-the-same-fragment preserves. `selectedKeys` (optional Set of `file|side|
// line` presence keys) drives the `.selected` range highlight — a line in the current
// selection or an active draft's span gets it, so a multi-line comment reads as a span.
// One diff line as an addressable, clickable row. `gutter` picks which line-number
// columns it carries: 'both' for the inline layout's full-width row, or 'old'/'new'
// for one cell of a side-by-side pair, where each column shows only its own file's
// numbering. Everything the comment delegation needs (file/side/line in data-*, the
// .diff-line class it hit-tests with .closest) is identical either way, which is what
// lets findLineRow, highlightRange, paintDragRange and the drag handler stay layout-
// agnostic.
export function lineRowEl(file, ln, selectedKeys, gutter = 'both') {
  const side = lineSide(ln.type);
  const num = lineNumberFor(ln);
  const sign = ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' ';
  const selected = Boolean(selectedKeys && num != null && selectedKeys.has(`${file}|${side}|${num}`));

  const row = el('div', `diff-line diff-line-${ln.type}${selected ? ' selected' : ''}`);
  row.dataset.key = draftKey(file, side, num, num); // this line's own single-line key
  row.dataset.file = file;
  row.dataset.side = side;
  row.dataset.line = String(num);
  row.title = 'Click to comment on this line, or drag to comment on a range';
  if (gutter !== 'new') row.append(el('span', 'diff-gutter diff-gutter-old', ln.oldLine == null ? '' : String(ln.oldLine)));
  if (gutter !== 'old') row.append(el('span', 'diff-gutter diff-gutter-new', ln.newLine == null ? '' : String(ln.newLine)));
  row.append(el('span', 'diff-sign', sign), el('span', 'diff-text', ln.text));
  return row;
}

export function lineEl(file, ln, drafts, selectedKeys) {
  const frag = document.createDocumentFragment();
  frag.append(lineRowEl(file, ln, selectedKeys, 'both'));
  const anchored = draftAnchoredAt(drafts, file, lineSide(ln.type), lineNumberFor(ln));
  if (anchored) frag.append(draftBlockEl(anchored.key, anchored.draft));
  return frag;
}

// One row of the side-by-side layout: a `.diff-row` grid wrapper holding the old-file
// cell and the new-file cell (from pairHunkLines), followed by any drafts anchored on
// either side. The wrapper is what makes the two columns line up — both cells sit in a
// single CSS grid row, so a long line wrapping on one side stretches BOTH and the
// columns can't drift apart.
//
// A missing side is a `.diff-cell-empty`, deliberately not a `.diff-line`: the drag
// delegation hit-tests with .closest('.diff-line'), so filler can never be resolved as
// a gesture target and needs no defensive dataset check.
//
// Drafts hang off the wrapper rather than the cell, so a draft block is never trapped
// inside a grid column (the same reason openEditor mounts its box on the wrapper).
// A context line is one logical line rendered twice — lineSide addresses it on the new
// side from either cell — so its single draft is de-duplicated by key rather than
// emitted once per cell. A del/add pair legitimately yields two distinct drafts (an
// old-side note and a new-side one), and both render.
export function pairRowEl(file, pair, drafts, selectedKeys) {
  const frag = document.createDocumentFragment();
  const wrap = el('div', 'diff-row');
  wrap.append(
    pair.left ? lineRowEl(file, pair.left, selectedKeys, 'old') : el('div', 'diff-cell-empty'),
    pair.right ? lineRowEl(file, pair.right, selectedKeys, 'new') : el('div', 'diff-cell-empty'),
  );
  frag.append(wrap);

  const seen = new Set();
  for (const ln of [pair.left, pair.right]) {
    if (!ln) continue;
    const anchored = draftAnchoredAt(drafts, file, lineSide(ln.type), lineNumberFor(ln));
    if (!anchored || seen.has(anchored.key)) continue;
    seen.add(anchored.key);
    frag.append(draftBlockEl(anchored.key, anchored.draft));
  }
  return frag;
}

// The inline comment editor (textarea + Cancel/Save) for a line span. A span label
// ("Line 12" / "Lines 12–18") headers it, and the placeholder names the range too.
// Both are set as text/properties, never interpolated into markup. Caller wires the
// button click handlers.
export function editorEl(side, startLine, endLine) {
  const ed = el('div', 'diff-editor');
  ed.append(el('div', 'diff-editor-loc', `${rangeLabel(startLine, endLine)} (${side})`));
  const ta = el('textarea', 'diff-editor-text');
  ta.rows = 3;
  ta.placeholder = startLine === endLine
    ? `Comment on ${side} line ${startLine}…`
    : `Comment on ${side} lines ${startLine}–${endLine}…`;
  const acts = el('div', 'diff-editor-acts');
  const cancel = el('button', 'ghost diff-editor-cancel', 'Cancel');
  cancel.type = 'button';
  const save = el('button', 'primary diff-editor-save', 'Save');
  save.type = 'button';
  acts.append(cancel, save);
  ed.append(ta, acts);
  return ed;
}



