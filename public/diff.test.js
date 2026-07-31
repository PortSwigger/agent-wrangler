import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftsStorageKey, lineSide, lineNumberFor, draftKey,
  buildCommentsPayload, draftCount, parseDrafts, isSaveCommentKey,
  diffLineKeys, partitionDrafts, isStaleReply, shouldDeferDiffRender,
  rangeSnapshot, rangeLabel, draftAnchoredAt, draftSpanKeys, dragRange,
} from './diff.js';

test('draftsStorageKey: namespaced per session id', () => {
  assert.equal(draftsStorageKey('card-1'), 'aw:diff-drafts:card-1');
});

test('lineSide: deletions address the old file, everything else the new', () => {
  assert.equal(lineSide('del'), 'old');
  assert.equal(lineSide('add'), 'new');
  assert.equal(lineSide('context'), 'new');
});

test('lineNumberFor: picks the number matching the line side', () => {
  assert.equal(lineNumberFor({ type: 'del', oldLine: 12, newLine: null }), 12);
  assert.equal(lineNumberFor({ type: 'add', oldLine: null, newLine: 40 }), 40);
  assert.equal(lineNumberFor({ type: 'context', oldLine: 5, newLine: 7 }), 7);
  assert.equal(lineNumberFor(null), null);
});

test('draftKey: file|side|startLine|endLine (single line has start === end)', () => {
  assert.equal(draftKey('src/a.js', 'new', 10, 10), 'src/a.js|new|10|10');
  assert.equal(draftKey('src/a.js', 'new', 10, 14), 'src/a.js|new|10|14');
});

test('rangeLabel: single line vs range (en dash)', () => {
  assert.equal(rangeLabel(12, 12), 'Line 12');
  assert.equal(rangeLabel(12, 18), 'Lines 12–18');
});

test('buildCommentsPayload: maps records, trims bodies, drops blanks, carries the span', () => {
  const drafts = {
    'a|new|1|1': { file: 'a', side: 'new', startLine: 1, endLine: 1, snapshot: 'foo', body: '  hello  ' },
    'a|new|2|2': { file: 'a', side: 'new', startLine: 2, endLine: 2, snapshot: 'bar', body: '   ' },
    'b|old|9|12': { file: 'b', side: 'old', startLine: 9, endLine: 12, snapshot: 'baz\nqux', body: 'why?' },
  };
  assert.deepEqual(buildCommentsPayload(drafts), [
    { file: 'a', side: 'new', startLine: 1, endLine: 1, snapshot: 'foo', body: 'hello' },
    { file: 'b', side: 'old', startLine: 9, endLine: 12, snapshot: 'baz\nqux', body: 'why?' },
  ]);
});

test('buildCommentsPayload: a legacy line-only draft is carried as a start===end span', () => {
  const drafts = { 'a|new|5': { file: 'a', side: 'new', line: 5, snapshot: 'x', body: 'note' } };
  assert.deepEqual(buildCommentsPayload(drafts), [
    { file: 'a', side: 'new', startLine: 5, endLine: 5, snapshot: 'x', body: 'note' },
  ]);
});

test('buildCommentsPayload: null/empty input is an empty array', () => {
  assert.deepEqual(buildCommentsPayload(null), []);
  assert.deepEqual(buildCommentsPayload({}), []);
});

test('draftCount: counts only non-blank drafts (single-line and range alike)', () => {
  assert.equal(draftCount({
    'a|new|1|1': { file: 'a', side: 'new', startLine: 1, endLine: 1, body: 'x' },
    'a|new|2|4': { file: 'a', side: 'new', startLine: 2, endLine: 4, body: '  ' },
  }), 1);
});

test('isSaveCommentKey: Cmd+Enter and Ctrl+Enter save, plain/Shift/Alt Enter do not', () => {
  assert.equal(isSaveCommentKey({ key: 'Enter', metaKey: true }), true);
  assert.equal(isSaveCommentKey({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isSaveCommentKey({ key: 'Enter' }), false); // plain Enter → newline
  assert.equal(isSaveCommentKey({ key: 'Enter', metaKey: true, shiftKey: true }), false);
  assert.equal(isSaveCommentKey({ key: 'Enter', ctrlKey: true, altKey: true }), false);
  assert.equal(isSaveCommentKey({ key: 'a', metaKey: true }), false);
  assert.equal(isSaveCommentKey(null), false);
});

test('buildCommentsPayload: preserves internal newlines in a multi-line body', () => {
  const drafts = {
    'a|new|1|1': { file: 'a', side: 'new', startLine: 1, endLine: 1, snapshot: 'x', body: '  first line\nsecond line\n\nfourth  ' },
  };
  // Only leading/trailing whitespace is trimmed; the interior newlines survive
  // so the multi-line comment reaches the agent intact.
  assert.deepEqual(buildCommentsPayload(drafts), [
    { file: 'a', side: 'new', startLine: 1, endLine: 1, snapshot: 'x', body: 'first line\nsecond line\n\nfourth' },
  ]);
});

test('parseDrafts: round-trips a stored range draft, keyed by its span, else {}', () => {
  const stored = { 'a|new|1|3': { file: 'a', side: 'new', startLine: 1, endLine: 3, snapshot: 's', body: 'one\ntwo' } };
  assert.deepEqual(parseDrafts(JSON.stringify(stored)), stored);
  assert.deepEqual(parseDrafts(''), {});
  assert.deepEqual(parseDrafts(null), {});
  assert.deepEqual(parseDrafts('not json'), {});
  assert.deepEqual(parseDrafts('[1,2,3]'), {});
  assert.deepEqual(parseDrafts('42'), {});
});

test('parseDrafts: a legacy single-line draft (old file|side|line key + line field) migrates to a span', () => {
  // Backward compat: an old draft persisted before range support had no start/end and
  // a shorter key. It must survive a load as startLine===endLine, RE-KEYED under the
  // range key so a later Save edits it in place instead of orphaning a duplicate.
  const legacy = JSON.stringify({ 'src/a.js|new|10': { file: 'src/a.js', side: 'new', line: 10, snapshot: 'foo()', body: 'why?' } });
  assert.deepEqual(parseDrafts(legacy), {
    'src/a.js|new|10|10': { file: 'src/a.js', side: 'new', startLine: 10, endLine: 10, snapshot: 'foo()', body: 'why?' },
  });
});

// The diff payload one line of every kind produces, for the key-collection tests.
const OK_DIFF = {
  state: 'ok',
  files: [
    { path: 'a.js', hunks: [{ header: '@@', lines: [
      { type: 'context', oldLine: 1, newLine: 1, text: 'x' },
      { type: 'del', oldLine: 2, newLine: null, text: 'gone' },
      { type: 'add', oldLine: null, newLine: 2, text: 'new' },
    ] }] },
    { path: 'bin.png', binary: true },
  ],
};

test('diffLineKeys: one key per content line, side-correct; binary/non-ok yield none', () => {
  assert.deepEqual([...diffLineKeys(OK_DIFF)].sort(), ['a.js|new|1', 'a.js|new|2', 'a.js|old|2'].sort());
  assert.equal(diffLineKeys({ state: 'empty' }).size, 0);
  assert.equal(diffLineKeys({ state: 'ok', files: [{ path: 'b', binary: true }] }).size, 0);
  assert.equal(diffLineKeys(null).size, 0);
});

test('partitionDrafts: drafts with a present line are attached, the rest detached', () => {
  const drafts = {
    'a.js|new|1': { file: 'a.js', side: 'new', line: 1, body: 'here' },   // present
    'a.js|old|2': { file: 'a.js', side: 'old', line: 2, body: 'del' },    // present
    'a.js|new|99': { file: 'a.js', side: 'new', line: 99, body: 'gone' }, // orphaned
  };
  const { attached, detached } = partitionDrafts(drafts, diffLineKeys(OK_DIFF));
  assert.deepEqual(Object.keys(attached).sort(), ['a.js|new|1', 'a.js|old|2']);
  assert.deepEqual(Object.keys(detached), ['a.js|new|99']);
});

test('partitionDrafts: every draft is detached when no line is present (empty diff / null keys)', () => {
  const drafts = { 'a|new|1': { body: 'x' }, 'b|old|2': { body: 'y' } };
  assert.deepEqual(Object.keys(partitionDrafts(drafts, new Set()).detached).sort(), ['a|new|1', 'b|old|2']);
  assert.deepEqual(Object.keys(partitionDrafts(drafts, null).detached).sort(), ['a|new|1', 'b|old|2']);
  assert.deepEqual(partitionDrafts(null, new Set()), { attached: {}, detached: {} });
});

test('partitionDrafts: a RANGE draft is attached iff both endpoints of its span are present', () => {
  // OK_DIFF's new side has lines 1 and 2 only.
  const drafts = {
    'a.js|new|1|2': { file: 'a.js', side: 'new', startLine: 1, endLine: 2, body: 'both here' },
    'a.js|new|1|3': { file: 'a.js', side: 'new', startLine: 1, endLine: 3, body: 'end line 3 gone' },
  };
  const { attached, detached } = partitionDrafts(drafts, diffLineKeys(OK_DIFF));
  assert.deepEqual(Object.keys(attached), ['a.js|new|1|2']);
  assert.deepEqual(Object.keys(detached), ['a.js|new|1|3']);
});

test('partitionDrafts: an OLD-side range spanning a context line stays attached (interior gaps ok)', () => {
  // Two deletions (old side) with a context line between them — the context line is
  // indexed on the NEW side, so an every-line rule would wrongly detach this. Endpoints
  // (both deletions) are present, so it's attached.
  const diff = { state: 'ok', files: [{ path: 'a.js', hunks: [{ header: '@@', lines: [
    { type: 'del', oldLine: 10, newLine: null, text: 'x' },
    { type: 'context', oldLine: 11, newLine: 11, text: 'y' },
    { type: 'del', oldLine: 12, newLine: null, text: 'z' },
  ] }] }] };
  const drafts = { 'a.js|old|10|12': { file: 'a.js', side: 'old', startLine: 10, endLine: 12, body: 'why remove?' } };
  const { attached } = partitionDrafts(drafts, diffLineKeys(diff));
  assert.deepEqual(Object.keys(attached), ['a.js|old|10|12']);
});

test('rangeSnapshot: marks in-range lines on the side with ">", numbers every row', () => {
  // OK_DIFF's whole 3-line hunk fits inside the ±3 context window either way, so
  // every query below returns all three rows — only the ">" marker moves. An
  // interleaved OTHER-side row (the deletion, when querying "new") is included as
  // unmarked context, never marked — matching highlightRange's side-scoping.
  assert.equal(rangeSnapshot(OK_DIFF, 'a.js', 'new', 1, 2), '> 1: x\n  2: gone\n> 2: new');
  assert.equal(rangeSnapshot(OK_DIFF, 'a.js', 'new', 2, 2), '  1: x\n  2: gone\n> 2: new');
  assert.equal(rangeSnapshot(OK_DIFF, 'a.js', 'old', 2, 2), '  1: x\n> 2: gone\n  2: new');
  assert.equal(rangeSnapshot(OK_DIFF, 'a.js', 'new', 5, 9), '');        // nothing in range
  assert.equal(rangeSnapshot(OK_DIFF, 'nope.js', 'new', 1, 2), '');     // no such file
  assert.equal(rangeSnapshot({ state: 'empty' }, 'a.js', 'new', 1, 2), '');
});

test('rangeSnapshot: includes up to SNAPSHOT_CONTEXT_LINES rows of context on each side', () => {
  const lines = Array.from({ length: 10 }, (_, i) => (
    { type: 'context', oldLine: i + 1, newLine: i + 1, text: `line${i + 1}` }
  ));
  const diff = { state: 'ok', files: [{ path: 'a.js', hunks: [{ header: '@@', lines }] }] };
  // Middle line: exactly 3 before + the target + 3 after (7 rows total).
  assert.equal(
    rangeSnapshot(diff, 'a.js', 'new', 5, 5),
    '  2: line2\n  3: line3\n  4: line4\n> 5: line5\n  6: line6\n  7: line7\n  8: line8',
  );
  // First line: context clamps at the hunk start (no rows before it to give).
  assert.equal(
    rangeSnapshot(diff, 'a.js', 'new', 1, 1),
    '> 1: line1\n  2: line2\n  3: line3\n  4: line4',
  );
});

test('draftSpanKeys: presence keys for every line of the span', () => {
  assert.deepEqual([...draftSpanKeys({ file: 'a', side: 'new', startLine: 3, endLine: 5 })].sort(),
    ['a|new|3', 'a|new|4', 'a|new|5']);
  assert.deepEqual([...draftSpanKeys({ file: 'a', side: 'old', line: 7 })], ['a|old|7']); // legacy single line
  assert.deepEqual([...draftSpanKeys(null)], []);
});

test('draftAnchoredAt: finds the draft whose endLine is this line, matched on file+side', () => {
  const drafts = {
    'a|new|1|3': { file: 'a', side: 'new', startLine: 1, endLine: 3 },
    'a|old|5|5': { file: 'a', side: 'old', startLine: 5, endLine: 5 },
  };
  assert.equal(draftAnchoredAt(drafts, 'a', 'new', 3).key, 'a|new|1|3'); // anchored under the last line
  assert.equal(draftAnchoredAt(drafts, 'a', 'new', 1), null);           // the start line is not the anchor
  assert.equal(draftAnchoredAt(drafts, 'a', 'old', 5).key, 'a|old|5|5');
  assert.equal(draftAnchoredAt(drafts, 'a', 'new', 99), null);
});

test('isStaleReply: an older reqId is stale; newer/equal and missing ids are not', () => {
  assert.equal(isStaleReply(1, 2), true);   // older pipeline landed after a newer poll
  assert.equal(isStaleReply(2, 2), false);  // the newest — apply it
  assert.equal(isStaleReply(3, 2), false);  // shouldn't happen, but never drop a newer
  assert.equal(isStaleReply(undefined, 2), false); // legacy reply w/o id — apply
  assert.equal(isStaleReply(1, undefined), false);
});

test('shouldDeferDiffRender: defers while an editor is open (flag OR DOM node)', () => {
  assert.equal(shouldDeferDiffRender('a|new|1', null), true);  // activeKey set
  assert.equal(shouldDeferDiffRender(null, {}), true);         // editor node in DOM
  assert.equal(shouldDeferDiffRender(null, null), false);      // nothing open — render
});

test('dragRange: normalises a drag into an inclusive same-side range (order-agnostic)', () => {
  const a = { file: 'src/a.js', side: 'new', line: 10 };
  // Drag downward
  assert.deepEqual(dragRange(a, { file: 'src/a.js', side: 'new', line: 14 }),
    { file: 'src/a.js', side: 'new', startLine: 10, endLine: 14 });
  // Drag upward normalises the same way
  assert.deepEqual(dragRange(a, { file: 'src/a.js', side: 'new', line: 6 }),
    { file: 'src/a.js', side: 'new', startLine: 6, endLine: 10 });
  // A single-line drag is startLine === endLine (a single-line comment)
  assert.deepEqual(dragRange(a, { file: 'src/a.js', side: 'new', line: 10 }),
    { file: 'src/a.js', side: 'new', startLine: 10, endLine: 10 });
});

test('dragRange: rejects a drag onto a different file or side, or missing endpoints', () => {
  const a = { file: 'src/a.js', side: 'new', line: 10 };
  assert.equal(dragRange(a, { file: 'src/b.js', side: 'new', line: 12 }), null); // other file
  assert.equal(dragRange(a, { file: 'src/a.js', side: 'old', line: 12 }), null); // other side
  assert.equal(dragRange(a, null), null);
  assert.equal(dragRange(null, a), null);
});
