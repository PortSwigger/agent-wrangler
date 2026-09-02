import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HINT_CHARS, hintLabels } from './hints.js';

test('hands out the easiest keys first, in order', () => {
  assert.deepEqual(hintLabels(5), ['f', 'r', 'd', 'e', 's']);
  assert.deepEqual(hintLabels(1), ['f']);
  assert.deepEqual(hintLabels(0), []);
});

test('the alphabet is complete, so 26 targets stay one keystroke', () => {
  assert.equal(new Set(HINT_CHARS).size, 26);
  assert.equal(hintLabels(26).join(''), HINT_CHARS);
});

test('past 26 only the overflow takes a second letter', () => {
  const labels = hintLabels(30);
  assert.equal(labels.length, 30);
  assert.equal(labels.filter((l) => l.length === 1).length, 25);
  assert.deepEqual(labels.slice(-5), ['ff', 'fr', 'fd', 'fe', 'fs']);
});

// Prefix-freeness is what makes "one match left ⇒ activate it" safe: without it
// a label could be both a complete answer and the start of another one.
test('no label is a prefix of another, at any size', () => {
  for (const count of [1, 26, 27, 51, 52, 700]) {
    const labels = hintLabels(count);
    assert.equal(labels.length, count);
    assert.equal(new Set(labels).size, count);
    for (const a of labels) {
      for (const b of labels) {
        if (a !== b) assert.ok(!b.startsWith(a), `${a} prefixes ${b} at count ${count}`);
      }
    }
  }
});

test('labels only ever use the hint alphabet', () => {
  for (const l of hintLabels(700)) {
    for (const ch of l) assert.ok(HINT_CHARS.includes(ch));
  }
});
