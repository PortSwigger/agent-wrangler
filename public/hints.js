// Labels for the board's hint-jump (⌃⌘A): give every session on screen a
// letter, then narrow by what's typed. Split out as a leaf because the two
// decisions here are the whole feature and both are easy to get subtly wrong.
//
// HINT_CHARS is ordered by how little the left hand has to move, not
// alphabetically. The full alphabet is present so 26 targets still label in one
// keystroke; the order only decides which letters are spent first — and, past
// 26, which letter becomes a prefix.
export const HINT_CHARS = 'frdesawqtgzxcvbjkliounmphy';

// Labels grow breadth-first, so passing 26 targets does NOT push every label to
// two letters: as many one-letter labels as possible survive and only the
// overflow takes a prefix — the cheapest letter, since it's the one being spent
// (30 targets → r…y as singles, then ff/fr/fd/fe/fs). The consumed prefixes are
// dropped from the result (that's what `slice(offset, …)` is doing), which is
// what keeps the set prefix-free: no label is ever a prefix of another, so the
// first label that matches what's typed is the only one that can.
export function hintLabels(count, chars = HINT_CHARS) {
  if (count <= 0 || chars.length < 2) return [];
  const labels = [''];
  let offset = 0;
  // `labels.length === 1` covers a single target: one label is "enough" by the
  // count test alone, but that label would be the empty seed.
  while (labels.length - offset < count || labels.length === 1) {
    const prefix = labels[offset++];
    for (const c of chars) labels.push(prefix + c);
  }
  return labels.slice(offset, offset + count);
}
