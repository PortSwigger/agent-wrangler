// The Usage & spend dashboard: a bottom-rail panel (modelled on the schedules
// panel) showing a stacked time series of spend ($) or token usage, bucketed
// day / week / month and SLICED by task, model, or token type. All data comes from
// the `usage` control-WS reply (server/control/handlers/usage.js); only the
// granularity toggle re-requests — the metric, slice, and filter all re-render the
// SAME payload client-side (every dimension's breakdown is already in each bucket).
// Charts are hand-rolled inline SVG built with document.createElementNS +
// textContent — no chart dependency, and task/model text (agent-generated) never
// goes in via innerHTML (the CodeQL DOM gate).
import { send } from './app.js';
import { fmtUsd, fmtTokens, fmtValue as fmtValueOf, cellValue as cellValueOf, dimensionMap as dimensionMapOf, rankMembers as rankMembersOf, displaySlots as displaySlotsOf, bucketSegments as bucketSegmentsOf, niceTicks, replyMatchesGranularity } from './usage-data.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Fixed categorical slots (validated for both themes via the dataviz palette). The
// stack + legend colour the active slice's members in active-metric order; beyond six
// (task/model) the rest fold into a neutral "Other" (never a cycled/synthesised hue).
// Token type is a fixed four, so it fills four slots and never folds. Defined as CSS
// vars in styles.css so light/dark swap in one place.
const CAT_VARS = ['--usage-cat-1', '--usage-cat-2', '--usage-cat-3', '--usage-cat-4', '--usage-cat-5', '--usage-cat-6'];
const OTHER_VAR = '--usage-cat-other';

const GRANULARITIES = [{ v: 'day', label: 'Daily' }, { v: 'week', label: 'Weekly' }, { v: 'month', label: 'Monthly' }];
// Metric collapsed to $ / Tokens: input/output/cache are no longer standalone metrics —
// that composition now lives in the "Token type" slice below.
const METRICS = [
  { v: 'usd', label: '$', axis: 'Spend (USD)' },
  { v: 'tokens', label: 'Tokens', axis: 'Tokens' },
];
// Slice dimension: what the bars stack by, the legend lists, and a chip filters on.
const SLICES = [
  { v: 'task', label: 'Task', dim: 'task' },
  { v: 'model', label: 'Model', dim: 'model' },
  { v: 'type', label: 'Token type', dim: 'type' },
];

const state = { granularity: 'day', metric: 'usd', sliceBy: 'task', filter: null, data: null };
let built = false;

const el = (id) => document.getElementById(id);

const metricDef = () => METRICS.find((m) => m.v === state.metric);
const dimension = () => SLICES.find((s) => s.v === state.sliceBy).dim;
const members = () => state.data?.dimensions?.[dimension()] || [];
// Thin wrappers binding the pure helpers to the current metric/slice/filter/palette.
const fmtValue = (n) => fmtValueOf(n, state.metric);
const cellValue = (cell) => cellValueOf(cell, state.metric);
const dimensionMap = (bucket) => dimensionMapOf(bucket, dimension());
// For task/model, rank members by the ACTIVE metric before taking colour slots, so the
// six coloured segments are the largest for what's shown (review nit: not always
// $-ranked — cache-heavy work ranks differently in tokens vs $). Token type is a fixed
// four that always all show, so it keeps its stable order/colour (Input is always the
// same hue) instead of reshuffling on a metric toggle.
const rankedMembers = () => (dimension() === 'type'
  ? members()
  : rankMembersOf(members(), state.data?.buckets, state.metric, dimension()));
const displaySlots = () => displaySlotsOf(rankedMembers(), CAT_VARS);
const bucketSegments = (bucket, slots) => bucketSegmentsOf(bucket, slots, state.metric, state.filter, OTHER_VAR, dimension());

function bucketLabel(startMs) {
  const d = new Date(startMs);
  const mo = MONTHS[d.getUTCMonth()];
  return state.granularity === 'month' ? mo : `${mo} ${d.getUTCDate()}`;
}
function rangeLabel() {
  const d = state.data;
  if (!d) return '';
  const a = new Date(d.rangeStart);
  const b = new Date(d.rangeEnd - 1);
  const f = (x) => `${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
  return f(a) === f(b) ? f(a) : `${f(a)} – ${f(b)}`;
}

// ---- rendering ------------------------------------------------------------
function renderControls() {
  const g = el('usage-granularity');
  g.replaceChildren(...GRANULARITIES.map((o) => {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.className = state.granularity === o.v ? 'active' : '';
    b.addEventListener('click', () => { if (state.granularity !== o.v) { state.granularity = o.v; requestData(); renderControls(); } });
    return b;
  }));
  const m = el('usage-metric');
  m.replaceChildren(...METRICS.map((o) => {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.className = state.metric === o.v ? 'active' : '';
    b.addEventListener('click', () => { if (state.metric !== o.v) { state.metric = o.v; renderAll(); } });
    return b;
  }));
  const sl = el('usage-slice');
  sl.replaceChildren(...SLICES.map((o) => {
    const b = document.createElement('button');
    b.textContent = o.label;
    b.className = state.sliceBy === o.v ? 'active' : '';
    // Switching dimension invalidates a filter keyed in the old dimension — clear it.
    b.addEventListener('click', () => { if (state.sliceBy !== o.v) { state.sliceBy = o.v; state.filter = null; renderAll(); } });
    return b;
  }));
}

function renderSummary() {
  const box = el('usage-summary');
  const d = state.data;
  if (!d) { box.replaceChildren(); return; }
  let total = 0;
  for (const b of d.buckets) {
    if (state.filter) total += cellValue(dimensionMap(b)[state.filter]);
    else total += cellValue({ usd: b.total.usd, tokens: b.total.tokens });
  }
  const big = document.createElement('div');
  big.className = 'usage-total';
  big.textContent = fmtValue(total);
  const sub = document.createElement('div');
  sub.className = 'usage-sub';
  const sliceLabel = SLICES.find((s) => s.v === state.sliceBy).label.toLowerCase();
  const scope = state.filter ? (members().find((m) => m.key === state.filter)?.name || 'segment') : `all ${sliceLabel}s`;
  sub.textContent = `${metricDef().axis} · ${scope} · ${rangeLabel()}`;
  box.replaceChildren(big, sub);
  // Codex usage is an estimate — flag it. On $ show the estimated dollar amount; on
  // token metrics the token counts are Codex-derived too (whole-lifetime, dumped on
  // createdAt), so note them estimated rather than implying parity with Claude's
  // line-stamped exact tokens.
  if (d.estimatedIncluded && !state.filter) {
    const est = document.createElement('div');
    est.className = 'usage-est';
    est.textContent = state.metric === 'usd'
      ? `includes ~${fmtUsd(d.totals.estimatedUsd)} estimated Codex spend`
      : 'includes estimated Codex usage';
    box.appendChild(est);
  }
  // Advisor consults are already inside the total above (real spend, never
  // dropped) — this just breaks out how much of it was the native advisor tool,
  // the same "of which" framing as the sub-agent/estimated notes.
  if (d.totals.advisorUsd > 0 && !state.filter) {
    const adv = document.createElement('div');
    adv.className = 'usage-est';
    adv.textContent = state.metric === 'usd'
      ? `includes ${fmtUsd(d.totals.advisorUsd)} spent on advisor consultations`
      : 'includes advisor consultation usage';
    // Deliberately not disjoint from a sub-agent's own cost (a sub-agent that
    // itself consulted the advisor counts in both figures) — say so on hover
    // rather than lengthening the visible line.
    adv.title = 'May overlap sub-agent spend — a sub-agent that itself consulted the advisor counts in both.';
    box.appendChild(adv);
  }
  // A transcript that failed to read/parse contributes nothing, so the total is a
  // lower bound — say so rather than presenting an understated figure as complete.
  if (d.failedFiles > 0) {
    const warn = document.createElement('div');
    warn.className = 'usage-est';
    warn.textContent = `${d.failedFiles} transcript${d.failedFiles === 1 ? '' : 's'} unreadable — total may be understated`;
    box.appendChild(warn);
  }
}

function svgEl(name, attrs) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}
// Rounded TOP corners only (the data end), square bottom so segments stack flush.
function barTopPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

function renderChart() {
  const host = el('usage-chart');
  host.replaceChildren(); // also drops any prior tooltip node — forget the stale ref
  tipEl = null;
  const d = state.data;
  if (!d) { const p = document.createElement('div'); p.className = 'usage-empty'; p.textContent = 'Loading…'; host.appendChild(p); return; }
  const slots = displaySlots();
  const buckets = d.buckets;
  const stacks = buckets.map((b) => bucketSegments(b, slots));
  const totals = stacks.map((segs) => segs.reduce((a, s) => a + s.value, 0));
  const max = Math.max(0, ...totals);
  if (max <= 0) { const p = document.createElement('div'); p.className = 'usage-empty'; p.textContent = 'No usage recorded in this period.'; host.appendChild(p); return; }

  const W = host.clientWidth || 720;
  const H = 300;
  const m = { top: 12, right: 14, bottom: 30, left: 52 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1] || max;
  const yOf = (v) => m.top + plotH - (v / yMax) * plotH;
  const band = plotW / buckets.length;
  const barW = Math.max(3, Math.min(band * 0.62, 46));

  const svg = svgEl('svg', { class: 'usage-svg', viewBox: `0 0 ${W} ${H}`, width: '100%', height: `${H}`, role: 'img', 'aria-label': `${metricDef().axis} by ${state.granularity}, sliced by ${SLICES.find((s) => s.v === state.sliceBy).label}` });

  // Y gridlines + labels (recessive).
  for (const t of ticks) {
    const y = yOf(t);
    svg.appendChild(svgEl('line', { class: 'usage-grid', x1: m.left, y1: y, x2: W - m.right, y2: y }));
    const lbl = svgEl('text', { class: 'usage-axis', x: m.left - 8, y: y + 3, 'text-anchor': 'end' });
    lbl.textContent = state.metric === 'usd' ? fmtUsd(t) : fmtTokens(t);
    svg.appendChild(lbl);
  }

  const everyX = Math.ceil(buckets.length / 12);
  buckets.forEach((bucket, i) => {
    const x = m.left + i * band + (band - barW) / 2;
    const g = svgEl('g', { class: 'usage-bar' });
    const segs = stacks[i];
    // Rounding radius is keyed off the WHOLE stack's height, not the top segment's own
    // height — else a thin top slice floors its own corner radius near 0 and looks
    // square next to bars where the top slice is tall (the original bug).
    const barH = yOf(0) - yOf(totals[i]);
    const rr = Math.min(4, barW / 2, barH);
    let acc = 0;
    segs.forEach((seg, si) => {
      const y0 = yOf(acc);
      const y1 = yOf(acc + seg.value);
      const gap = si === 0 ? 0 : 2; // 2px surface gap between stacked segments
      const top = si === segs.length - 1;
      // The top segment must be at least as tall as the corner radius, or the round
      // cap has no solid colour to curve through and either looks square (bug) or,
      // clipped to the real height, leaves a gap notch inside the curve. Let it
      // bleed a couple px into the segment below instead — same trade-off as the
      // 1px floor below already makes for visibility.
      const h = top ? Math.max(rr, y0 - y1 - gap) : Math.max(1, y0 - y1 - gap);
      const mark = top
        ? svgEl('path', { d: barTopPath(x, y1, barW, h, 4) })
        : svgEl('rect', { x, y: y1, width: barW, height: h });
      mark.style.setProperty('fill', `var(${seg.colorVar})`);
      const title = svgEl('title');
      title.textContent = `${seg.name}: ${fmtValue(seg.value)}`;
      mark.appendChild(title);
      g.appendChild(mark);
      acc += seg.value;
    });
    // Hover: a per-bucket breakdown tooltip (dataviz default for bar marks). An
    // invisible full-height hit target makes the whole column hoverable, not just
    // the drawn bar.
    const hit = svgEl('rect', { class: 'usage-hit', x: m.left + i * band, y: m.top, width: band, height: plotH });
    hit.addEventListener('mousemove', (ev) => showTip(ev, bucket, segs, totals[i]));
    hit.addEventListener('mouseleave', hideTip);
    g.appendChild(hit);
    svg.appendChild(g);

    if (i % everyX === 0 || i === buckets.length - 1) {
      const lbl = svgEl('text', { class: 'usage-axis', x: m.left + i * band + band / 2, y: H - 10, 'text-anchor': 'middle' });
      lbl.textContent = bucketLabel(bucket.start);
      svg.appendChild(lbl);
    }
  });

  svg.appendChild(svgEl('line', { class: 'usage-baseline', x1: m.left, y1: m.top + plotH, x2: W - m.right, y2: m.top + plotH }));
  host.appendChild(svg);
}

let tipEl = null;
function showTip(ev, bucket, segs, total) {
  const host = el('usage-chart');
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'usage-tip'; host.appendChild(tipEl); }
  const head = document.createElement('div');
  head.className = 'usage-tip-head';
  head.textContent = bucketLabel(bucket.start);
  const rows = segs.slice().reverse().map((s) => {
    const r = document.createElement('div');
    r.className = 'usage-tip-row';
    const sw = document.createElement('span');
    sw.className = 'usage-sw';
    sw.style.setProperty('background', `var(${s.colorVar})`);
    const nm = document.createElement('span'); nm.className = 'usage-tip-name'; nm.textContent = s.name;
    const val = document.createElement('span'); val.className = 'usage-tip-val'; val.textContent = fmtValue(s.value);
    r.append(sw, nm, val);
    return r;
  });
  const tot = document.createElement('div');
  tot.className = 'usage-tip-total';
  tot.textContent = `Total ${fmtValue(total)}`;
  tipEl.replaceChildren(head, ...rows, tot);
  const box = host.getBoundingClientRect();
  let left = ev.clientX - box.left + 12;
  const top = ev.clientY - box.top + 12;
  if (left + 180 > box.width) left = ev.clientX - box.left - 180 - 12;
  tipEl.style.left = `${Math.max(0, left)}px`;
  tipEl.style.top = `${top}px`;
  tipEl.classList.add('show');
}
function hideTip() { if (tipEl) tipEl.classList.remove('show'); }

function renderLegend() {
  const box = el('usage-legend');
  const d = state.data;
  if (!d) { box.replaceChildren(); return; }
  const slots = displaySlots();
  // Per-legend-item window totals for the current metric, so the legend doubles as a
  // ranked readout (and satisfies the relief rule — identity is never colour-alone).
  const items = slots.shown.map((s) => {
    let v = 0;
    for (const b of d.buckets) v += cellValue(dimensionMap(b)[s.key]);
    return { ...s, value: v };
  });
  if (slots.foldedKeys.length) {
    let v = 0;
    for (const b of d.buckets) for (const k of slots.foldedKeys) v += cellValue(dimensionMap(b)[k]);
    if (v > 0) items.push({ key: '__other', name: 'Other', colorVar: OTHER_VAR, value: v, other: true });
  }
  box.replaceChildren(...items.map((it) => {
    const chip = document.createElement('button');
    chip.className = 'usage-leg' + (state.filter === it.key ? ' active' : '') + (state.filter && state.filter !== it.key ? ' dim' : '');
    const sw = document.createElement('span'); sw.className = 'usage-sw'; sw.style.setProperty('background', `var(${it.colorVar})`);
    const nm = document.createElement('span'); nm.className = 'usage-leg-name'; nm.textContent = it.name;
    const val = document.createElement('span'); val.className = 'usage-leg-val'; val.textContent = fmtValue(it.value);
    chip.append(sw, nm, val);
    // "Other" is an aggregate, not a single task — not filterable. Guard on the fold
    // flag, not the key string, so a real member literally named "__other" stays a
    // normal filterable member instead of colliding with the fold sentinel.
    if (!it.other) {
      chip.addEventListener('click', () => { state.filter = state.filter === it.key ? null : it.key; renderAll(); });
    } else { chip.disabled = true; }
    return chip;
  }));
}

function renderAll() { renderControls(); renderSummary(); renderChart(); renderLegend(); }

function requestData() {
  el('usage-chart').replaceChildren(Object.assign(document.createElement('div'), { className: 'usage-empty', textContent: 'Loading…' }));
  send({ type: 'usage', granularity: state.granularity });
}

// ---- public API -----------------------------------------------------------
export function onUsage(msg) {
  // Drop a stale reply for a since-toggled granularity — replies are fire-and-forget
  // and can resolve out of order, so a late Daily reply must not render under Monthly.
  if (!replyMatchesGranularity(msg, state.granularity)) return;
  state.data = msg;
  // A filter can outlive its member (a granularity switch drops it from the range).
  if (state.filter && !members().some((m) => m.key === state.filter)) state.filter = null;
  if (!el('usage-modal').classList.contains('hidden')) renderAll();
}

export function openUsagePanel() {
  const modal = el('usage-modal');
  modal.classList.remove('hidden');
  if (!built) { built = true; wire(); }
  renderControls();
  requestData();
}
function closeUsagePanel() { el('usage-modal').classList.add('hidden'); hideTip(); }

function wire() {
  el('usage-close').addEventListener('click', closeUsagePanel);
  const modal = el('usage-modal');
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeUsagePanel(); } });
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeUsagePanel(); });
  // Redraw on resize so the SVG tracks the panel width while it's open.
  window.addEventListener('resize', () => { if (!modal.classList.contains('hidden') && state.data) renderChart(); });
}
