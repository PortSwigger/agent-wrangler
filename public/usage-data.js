// Pure, DOM-free transforms for the Usage dashboard, split out of usage.js so the
// metric-extraction / task-folding / axis-tick logic is unit-testable without a
// browser (model: snooze.js / schedules.js). usage.js owns all the SVG/DOM.

// The slot count is a single source of truth: usage.js's CAT_VARS palette, passed to
// displaySlots as catVars — beyond catVars.length tasks the rest fold into one "Other"
// series rather than a cycled hue (dataviz non-negotiable). No second literal "6" here
// to drift out of sync with the palette length.

// A fire-and-forget usage reply for a granularity the user has since toggled away from
// must not render (its day-buckets would land under a month axis, etc.). The reply
// self-describes its granularity — accept it only when it still matches the live one.
export function replyMatchesGranularity(msg, granularity) {
  return !msg || !msg.granularity || msg.granularity === granularity;
}

export function fmtUsd(n) { return `$${n.toFixed(2)}`; }
export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return `${Math.round(n)}`;
}
export const fmtValue = (n, metric) => (metric === 'usd' ? fmtUsd(n) : fmtTokens(n));

// The active dimension's per-key breakdown on a bucket: byTask / byModel / byType. One
// helper keeps every consumer (segments, legend, filter, summary) reading the same map.
export function dimensionMap(bucket, dimension) {
  if (!bucket) return {};
  if (dimension === 'model') return bucket.byModel || {};
  if (dimension === 'type') return bucket.byType || {};
  return bucket.byTask || {};
}

// The current metric's scalar from one {usd, tokens:{…}} cell (0 when the key had no
// spend in that bucket). $ reads the dollar figure; Tokens sums all token types — for a
// Token-type cell only its own slot is populated, so the sum is that type's count.
export function cellValue(cell, metric) {
  if (!cell) return 0;
  if (metric === 'usd') return cell.usd || 0;
  const t = cell.tokens || {};
  return (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) + (t.cacheRead || 0);
}

// Rank a dimension's members by their in-window total for the ACTIVE metric, so the
// colour slots and stack order always track the biggest contributors of what's shown
// (not always $ — cache-read dwarfs input in tokens but is tiny in $). Server default
// order is $-ranked; this re-ranks client-side when the metric toggles.
export function rankMembers(members, buckets, metric, dimension) {
  return (members || []).map((m) => {
    let value = 0;
    for (const b of buckets || []) value += cellValue(dimensionMap(b, dimension)[m.key], metric);
    return { key: m.key, name: m.name, value };
  }).sort((a, b) => b.value - a.value);
}

// Top members (already ranked by the caller) get a colour slot; the remainder's keys
// fold into "Other". A fixed dimension (Token type: 4 ≤ catVars) never folds.
export function displaySlots(members, catVars) {
  const shown = (members || []).slice(0, catVars.length).map((m, i) => ({ key: m.key, name: m.name, colorVar: catVars[i] }));
  const foldedKeys = (members || []).slice(catVars.length).map((m) => m.key);
  return { shown, foldedKeys };
}

// The non-zero series (in stack order) one bucket contributes for a metric, honouring
// an optional single-member filter. Folded members collapse into one "Other" segment
// (omitted under a filter — a filter shows exactly one member).
export function bucketSegments(bucket, slots, metric, filter, otherVar, dimension) {
  const map = dimensionMap(bucket, dimension);
  const segs = [];
  for (const s of slots.shown) {
    if (filter && filter !== s.key) continue;
    segs.push({ key: s.key, name: s.name, colorVar: s.colorVar, value: cellValue(map[s.key], metric) });
  }
  if (!filter && slots.foldedKeys.length) {
    let v = 0;
    for (const k of slots.foldedKeys) v += cellValue(map[k], metric);
    if (v > 0) segs.push({ key: '__other', name: 'Other', colorVar: otherVar, value: v, other: true });
  }
  return segs.filter((s) => s.value > 0);
}

// Ticks 0..>=max in a round step, so the axis top always covers the tallest bar.
export function niceTicks(max) {
  if (max <= 0) return [0];
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].map((s) => s * pow).find((s) => max / s <= 4) || 10 * pow;
  const out = [0];
  for (let t = 0; t < max - 1e-9; ) { t += step; out.push(t); }
  return out;
}
