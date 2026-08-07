import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRegion, isWholeWordAt, snippetBounds, charTrimRange, trimToCharBoundaries } from './scan.js';
import { collectHits, emptyResult } from './scan-core.js';
import { RECORD_SIZE, writeRecord, recordIndexAt, ROLE_USER, ROLE_ASSISTANT } from './records.js';

function hitsOf(hay, needle, opts = {}) {
  const found = [];
  scanRegion(Buffer.from(hay), Buffer.from(needle), { ...opts, onHit: (at) => { found.push(at); } });
  return found;
}

test('finds every non-overlapping occurrence', () => {
  assert.deepEqual(hitsOf('abcabcabc', 'abc'), [0, 3, 6]);
  assert.deepEqual(hitsOf('aaaa', 'aa'), [0, 2]); // grep semantics, not overlapping
});

test('the `to` bound stops a hit the next slab owns', () => {
  // 'xx' starts at 4, which is outside [0, 4) — the next slab reports it.
  assert.deepEqual(hitsOf('abcdxxef', 'xx', { to: 4 }), []);
  assert.deepEqual(hitsOf('abcdxxef', 'xx', { from: 4 }), [4]);
});

test('whole word rejects matches glued to word characters', () => {
  assert.deepEqual(hitsOf('cat catalog scat cat.', 'cat', { wholeWord: true }), [0, 17]);
  assert.deepEqual(hitsOf('cat catalog', 'cat'), [0, 4]);
});

test('a multi-byte letter counts as a word character', () => {
  // "café" must not match whole-word inside "cafés"; every byte ≥ 0x80 is a word byte.
  const hay = Buffer.from('cafés');
  assert.equal(isWholeWordAt(hay, 0, Buffer.byteLength('café')), false);
});

test('buffer edges read as word boundaries', () => {
  assert.deepEqual(hitsOf('cat', 'cat', { wholeWord: true }), [0]);
});

test('snippet window clamps to its own message', () => {
  // A message occupying [100, 120): a wide radius can't spill into its neighbours.
  assert.deepEqual(snippetBounds(100, 20, 110, 3, 500), { start: 100, end: 120 });
  assert.deepEqual(snippetBounds(100, 20, 110, 3, 4), { start: 106, end: 117 });
});

test('char trimming drops partial UTF-8 at both edges', () => {
  const full = Buffer.from('日本語');       // 3 bytes per character
  const cut = full.subarray(1, 8);          // starts mid-char, ends mid-char
  const trimmed = trimToCharBoundaries(cut);
  assert.equal(trimmed.toString('utf8'), '本');
  assert.deepEqual(charTrimRange(Buffer.from('ok')), { start: 0, end: 2 });
});

// ── record lookup + hit collection ─────────────────────────────────────────

// Three messages laid out NUL-separated, as the indexer writes them.
function fixture() {
  const msgs = [
    { text: 'alpha beta', role: ROLE_USER, tsSec: 1000, docIdx: 0 },
    { text: 'gamma beta delta', role: ROLE_ASSISTANT, tsSec: 2000, docIdx: 0 },
    { text: 'beta epsilon', role: ROLE_USER, tsSec: 3000, docIdx: 1 },
  ];
  const parts = [];
  const recBuf = Buffer.alloc(msgs.length * RECORD_SIZE);
  let at = 0;
  msgs.forEach((m, i) => {
    const b = Buffer.from(m.text);
    parts.push(b, Buffer.from([0]));
    writeRecord(recBuf, i, { offset: at, len: b.length, docIdx: m.docIdx, tsSec: m.tsSec, role: m.role });
    at += b.length + 1;
  });
  return { hay: Buffer.concat(parts), recBuf, count: msgs.length };
}

test('a hit resolves to the message that contains it', () => {
  const { hay, recBuf, count } = fixture();
  assert.equal(recordIndexAt(recBuf, 0, 0, count), 0);
  assert.equal(recordIndexAt(recBuf, 12, 0, count), 1);
  assert.equal(recordIndexAt(recBuf, hay.length - 2, 0, count), 2);
});

test('collectHits counts every match and attributes each to its message', () => {
  const { hay, recBuf, count } = fixture();
  const out = collectHits({ hay, needle: Buffer.from('beta'), recBuf, recCount: count, limit: 10, out: emptyResult() });
  assert.equal(out.matches, 3);
  assert.deepEqual(out.perDoc, { 0: 2, 1: 1 });
  assert.deepEqual(out.hits.map((h) => h.role), [ROLE_USER, ROLE_ASSISTANT, ROLE_USER]);
});

test('role and doc filters shrink the count, not just the payload', () => {
  const { hay, recBuf, count } = fixture();
  const userOnly = collectHits({ hay, needle: Buffer.from('beta'), recBuf, recCount: count, roleMask: 1 << ROLE_USER, out: emptyResult() });
  assert.equal(userOnly.matches, 2);
  const docOnly = collectHits({ hay, needle: Buffer.from('beta'), recBuf, recCount: count, docMask: Buffer.from([0, 1]), out: emptyResult() });
  assert.equal(docOnly.matches, 1);
  assert.equal(docOnly.hits[0].docIdx, 1);
});

test('the cap limits collected hits but never the count', () => {
  const { hay, recBuf, count } = fixture();
  const out = collectHits({ hay, needle: Buffer.from('beta'), recBuf, recCount: count, limit: 1, out: emptyResult() });
  assert.equal(out.matches, 3);
  assert.equal(out.hits.length, 1);
});

test('a match can never span two messages', () => {
  const { hay, recBuf, count } = fixture();
  // 'beta\0gamma' spans the NUL separator; NUL is stripped from queries, and no
  // needle containing one can be built, so nothing matches across the boundary.
  const out = collectHits({ hay, needle: Buffer.from('betagamma'), recBuf, recCount: count, out: emptyResult() });
  assert.equal(out.matches, 0);
});

test('the monotonic record cursor agrees with a fresh binary search', () => {
  const { hay, recBuf, count } = fixture();
  // Scanning 'a' hits many times, walking the cursor forward across all three
  // messages; every attribution must still be right.
  const out = collectHits({ hay, needle: Buffer.from('a'), recBuf, recCount: count, limit: 100, out: emptyResult() });
  for (const h of out.hits) {
    assert.equal(h.docIdx, recBuf.readUInt32LE(recordIndexAt(recBuf, h.hitOffset, 0, count) * RECORD_SIZE + 8));
  }
});
