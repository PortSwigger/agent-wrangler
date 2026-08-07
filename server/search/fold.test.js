import test from 'node:test';
import assert from 'node:assert/strict';
import { foldBytes, foldNeedle, foldInto } from './fold.js';

// The one property the whole index depends on: folding never changes byte length,
// so an offset in corpus.lc is the same offset in corpus.txt.
test('folding preserves byte length for every input', () => {
  for (const s of ['ABC', 'İstanbul', 'ǅungla', 'ẞ', 'Ǆ', '漢字', 'ÀÉÎÕÜÞ', 'a'.repeat(300), '']) {
    const src = Buffer.from(s, 'utf8');
    assert.equal(foldBytes(src).length, src.length, `length changed for ${JSON.stringify(s)}`);
  }
});

test('ASCII folds, and a query folds to match it', () => {
  assert.equal(foldBytes(Buffer.from('Hello WORLD_42')).toString(), 'hello world_42');
  assert.equal(foldNeedle('WoRlD').toString(), 'world');
});

test('Latin-1 accented capitals fold; multiplication sign does not', () => {
  assert.equal(foldBytes(Buffer.from('CAFÉ ÀÖÜ')).toString(), 'café àöü');
  // 0xC3 0x97 is ×, not a letter — folding it would turn it into ÷ (0xC3 0xB7).
  assert.equal(foldBytes(Buffer.from('3 × 4')).toString(), '3 × 4');
});

test('non-Latin scripts are left alone (documented limitation)', () => {
  const s = 'ΔΕΛΤΑ ДЕЛЬТА';
  assert.equal(foldBytes(Buffer.from(s)).toString(), s);
});

test('foldInto can fold in place', () => {
  const buf = Buffer.from('MiXeD');
  foldInto(buf, buf);
  assert.equal(buf.toString(), 'mixed');
});
