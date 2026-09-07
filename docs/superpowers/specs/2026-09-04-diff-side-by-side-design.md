# Side-by-side diffs in the session diff view

**Date:** 2026-09-04
**Status:** approved

## Problem

The session diff view renders every file as a single column of unified-diff
lines. For a change that rewrites a line rather than adding or removing one,
that means reading a `−` row and a `+` row several lines apart and diffing them
by eye. Every other review surface the team uses (GitHub, the IDE) offers a
side-by-side layout for exactly this; the wrangler's diff view does not.

Add a layout toggle at the top of the panel: **Inline** (today's behaviour) or
**Side-by-side**.

## Scope decisions

Two questions were settled before design:

- **Commenting keeps full parity in side-by-side.** Click-to-comment and
  drag-to-select-a-range work in both layouts. The diff view exists to leave
  review comments; a layout you cannot comment in would just be a mode people
  bounce out of.
- **The toggle is always honoured, at any panel width.** The diff panel shares
  the content area with the terminal sidebar unless its own fullscreen is on, so
  side-by-side can be narrow. Line text already wraps (`white-space: pre-wrap`
  + `word-break: break-word`), so narrow means more wrapping, not clipping.
  Deliberately no width-threshold auto-fallback to inline: a toggle that
  silently does nothing at some widths is worse than a cramped one you can fix
  with the fullscreen button you are already next to.

## The structural problem

Every comment affordance in the panel hangs off `.diff-line` elements carrying
`data-file` / `data-side` / `data-line`:

- `dragRowFromEvent` / the `bodyEl` mousedown handler resolve the gesture target
  with `.closest('.diff-line')`
- `paintDragRange`, `highlightRange` and `findLineRow` scan
  `bodyEl.querySelectorAll('.diff-line')` and filter on the dataset
- `openEditor` mounts the comment box with `anchorRow.after(ed)` and looks at
  `anchorRow.nextElementSibling` for an existing draft block
- `lineEl` appends a draft block as the row's immediate next sibling, which the
  click delegation relies on

Side-by-side splits one row into two cells. What those cells are, structurally,
is the whole design.

### Options considered

**A. Paired-row wrapper (chosen).** A `.diff-row` grid container holds a left
and a right `.diff-line` cell. The two cells occupy one CSS grid row, so they
stretch to the taller of the pair — wrapping on one side cannot misalign the
columns. Every `querySelectorAll('.diff-line')` consumer keeps working
unchanged, because the cells *are* `.diff-line`s with the same dataset.

**B. Flat grid per hunk.** Cells as direct siblings of one grid container,
placed with `grid-column`. Tempting because `anchorRow.after(ed)` would work
verbatim. Rejected: a draft block or editor inserted after a left cell lands
between the pair, and grid auto-placement pushes the right cell onto its own
row.

**C. Two independently scrolling columns.** Rejected: alignment depends on
equal row heights, which wrapping breaks — the columns would drift apart the
first time a long line wraps on one side only.

## Design

### 1. Pairing — `public/diff.js`

New pure export `pairHunkLines(lines)` returning `[{ left, right }]`, where each
side is a line object or `null`.

Walk the hunk's lines, accumulating a pending run of deletions and additions:

- a `context` line flushes the pending run, then emits `{ left: ln, right: ln }`
- a `del` joins the pending deletions — but a `del` seen *after* an `add` in the
  current run flushes first and starts a new run (unified diff always writes
  `−` before `+` within a change block, so this only guards against malformed
  input rather than a case git produces)
- an `add` joins the pending additions
- a flush zips the two runs positionally:
  `{ left: dels[i] ?? null, right: adds[i] ?? null }` for `i` up to the longer
  run

So a pure insertion yields empty left cells, a pure deletion empty right cells,
and a rewrite pairs old against new line-for-line.

Lives beside `lineSide` / `lineNumberFor` / `draftKey` in `diff.js` — the
existing pure leaf, importable under `node --test` with no DOM.

### 2. Rendering — `public/diff-dom.js`

Extract the row-building half of `lineEl` into
`lineRowEl(file, ln, selectedKeys, gutter)`, where `gutter` is `'both'` (today's
two-gutter inline row), `'old'` or `'new'` (one gutter, for a side-by-side
cell). `lineEl` keeps composing that row with its anchored draft block and is
otherwise unchanged, so inline rendering is byte-identical to today.

New `pairRowEl(file, pair, drafts, selectedKeys)` returns a fragment:

- a `.diff-row` wrapper containing the left cell (`gutter: 'old'`) and the right
  cell (`gutter: 'new'`)
- a missing side renders as `.diff-cell-empty` — deliberately **not** a
  `.diff-line`, so `dragRowFromEvent`'s `.closest('.diff-line')` can never
  resolve to it and it needs no defensive dataset check
- any draft anchored at either side is appended **after the wrapper**, full
  width, so a draft block is never trapped inside a grid cell

All values still enter via `textContent` / `dataset`, never `innerHTML` — the
module's standing rule, since diff text is agent- and repo-generated.

### 3. Comment parity — `public/diff-view.js`

Because the cells carry the same `data-file` / `data-side` / `data-line` a
unified row does, `findLineRow`, `highlightRange`, `paintDragRange`,
`dragRange` and the mousedown handler all work untouched.

The one change is where the editor mounts. `openEditor` currently does
`anchorRow.after(ed)`; in side-by-side the anchor row is a cell inside a grid
container, so the editor would be placed as a grid item. A small
`mountRowFor(row)` helper returns `row.closest('.diff-row') ?? row`, giving the
pair wrapper in side-by-side and the row itself inline.

**A context line renders in both cells with the same identity.** `lineSide`
addresses an unchanged line on the `new` side regardless of layout, so both
cells of a context pair carry `side: 'new'` and the same line number even
though the left gutter shows the old number. That is deliberate and correct:
clicking either side of an unchanged line opens the same draft, and the draft
renders once under the pair. `findLineRow` returning the left cell is harmless,
since the editor mounts on the wrapper either way.

### 4. The toggle

A segmented `Inline` / `Side-by-side` pair in `public/index.html`, reusing the
existing `.diff-mode-btn` shape, placed at the start of `.diff-head-acts`
(to the left of Send and the fullscreen button).

Kept out of the `.diff-mode` group on purpose. That group answers *what is being
diffed* (Uncommitted / Full branch / a linked PR) and its PR buttons are
rendered dynamically, so a layout control dropped in there would be shoved
around by unrelated state. The layout answers *how it is drawn* — the same
concern as the fullscreen button it now sits beside.

`setLayout(layout)` follows `setMode`'s established shape: cancel any live drag,
close an open editor, apply the new layout, re-render. It does **not**
re-request the diff — the data is identical, only the rendering changes.

### 5. Persistence

`cm-diff-layout` in `localStorage`, read once at module load, global rather than
per-session.

This deliberately differs from `diffMode`, which resets to `working-tree` on
every genuinely fresh open. Diff mode is a scope choice that belongs to the
review you are starting; layout is a viewing preference, in the same family as
`cm-diff-filelist-w`, `cm-theme` and the font-size keys, and should survive a
reload the way those do.

### 6. CSS — `public/styles.css`

```
.diff-row { display: grid; grid-template-columns: 1fr 1fr; }
```

with a divider border between the columns and a subtle neutral fill on
`.diff-cell-empty`. Theme variables only — no hardcoded hex, and it must read
correctly in both dark and light.

Cells keep `.diff-line`'s existing flex layout, so the add/del tints, the
`.selected` / `.drag-selecting` range highlights and the gutter colours all
apply unchanged.

## Testing

**`public/diff.test.js`** — `pairHunkLines`:

- a pure insertion pairs every add against a `null` left
- a pure deletion pairs every del against a `null` right
- an even rewrite pairs del[i] against add[i]
- an uneven run (3 dels, 1 add) pads the shorter side with `null`
- a context line flushes the pending run and emits on both sides
- consecutive change blocks separated by context do not bleed into one another

**`public/diff-dom.test.js`** — `pairRowEl`, against the existing minimal
`document` stub:

- both cells are `.diff-line`s carrying the file/side/line dataset
- a missing side renders `.diff-cell-empty` and no `.diff-line`
- a draft anchored at either side lands after the wrapper, not inside a cell
- line text enters via `textContent` (the module's XSS-safety assertion,
  extended to the new builder)

Plus `npm test` overall, and a browser pass via the `wrangler-verify-ui` skill
against an isolated dev instance, since this is a `public/` change.

## Out of scope

- Word-level intra-line highlighting within a paired row
- Syntax highlighting
- Any change to the diff payload the server sends, or to the comment payload
  sent to the agent — this is purely a client-side rendering choice
