// Pure, DOM-free date-range logic for the Usage dashboard, split out like snooze.js /
// chat-font.js so it's unit-testable under node with no browser. This leaf deliberately
// imports NOTHING from server code: the design decision (not to be revisited) is that
// the CLIENT resolves presets to absolute UTC day keys and the SERVER only ever sees
// absolute start/end — no preset vocabulary crosses the wire, so the two sides never
// have to agree on what "this month" means. usage.js owns all the DOM/localStorage
// wiring; this module owns the arithmetic.

const DAY_MS = 86_400_000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcDayStart = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDayKey = (v) => typeof v === 'string' && DAY_KEY_RE.test(v);

// Ordered preset list for the range <select>. 'custom' is last — it's the escape hatch
// that reveals the two date inputs, not a computed window.
export const RANGE_PRESETS = [
  { v: 'last-7', label: 'Last 7 days' },
  { v: 'last-30', label: 'Last 30 days' },
  { v: 'last-90', label: 'Last 90 days' },
  { v: 'this-month', label: 'This month' },
  { v: 'last-month', label: 'Last month' },
  { v: 'this-year', label: 'This year' },
  { v: 'all-time', label: 'All time' },
  { v: 'custom', label: 'Custom' },
];

// A cold open must render exactly what today's (pre-range-selector) panel renders —
// the Daily default window is 30 buckets — so this feature can't change what an
// untouched dashboard shows on first load.
export const DEFAULT_RANGE = 'last-30';

// Resolve a preset to absolute UTC day-key strings, or nulls (meaning "unbounded on
// that side") — `now` is INJECTED, never read internally, so tests can freeze the
// clock (same discipline as resolveUntil in snooze.js and `now` in rollup). All
// arithmetic is UTC, matching the server's buckets.
export function resolvePreset(v, nowMs) {
  const today = utcDayStart(nowMs);
  if (v === 'last-7') return { start: dayKey(today - 6 * DAY_MS), end: dayKey(today) };
  if (v === 'last-30') return { start: dayKey(today - 29 * DAY_MS), end: dayKey(today) };
  if (v === 'last-90') return { start: dayKey(today - 89 * DAY_MS), end: dayKey(today) };
  if (v === 'this-month') {
    const d = new Date(today);
    return { start: dayKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), end: dayKey(today) };
  }
  if (v === 'last-month') {
    const d = new Date(today);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0); // day 0 of this month = last day of previous month
    return { start: dayKey(start), end: dayKey(end) };
  }
  if (v === 'this-year') {
    const d = new Date(today);
    return { start: dayKey(Date.UTC(d.getUTCFullYear(), 0, 1)), end: dayKey(today) };
  }
  // 'all-time' and 'custom' (and any unrecognised value) both resolve to fully
  // unbounded — for custom the caller supplies concrete from/to on top of this.
  return { start: null, end: null };
}

// The client's own copy of the server's hard cap (server/usage-report.js MAX_BUCKETS).
// DUPLICATED ON PURPOSE: this leaf must stay import-free of server code, and this
// number exists only to pre-grey a granularity before a round trip — it is not the
// authority. The server's copy is the authority; if the two ever drift, the client
// pre-greys slightly wrong but the server's own clamp+note still catches it.
export const MAX_BUCKETS = 400;
export const MIN_BUCKETS = 2;

// Arithmetic, NOT enumeration — this runs on every keystroke in a date input, so it
// must be O(1). `endMs` is EXCLUSIVE, the same [start, end) convention windowBetween
// uses server-side. day/week: ceil of the ms span over the bucket width. month: a
// calendar month difference + 1 (endMs is exclusive, so the last INCLUDED instant is
// endMs - 1).
export function bucketCountFor(startMs, endMs, granularity) {
  if (!(endMs > startMs)) return 0;
  if (granularity === 'week') return Math.ceil((endMs - startMs) / (7 * DAY_MS));
  if (granularity === 'month') {
    const a = new Date(startMs);
    const b = new Date(endMs - 1);
    const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
    return Math.max(1, months);
  }
  return Math.ceil((endMs - startMs) / DAY_MS); // day (and any unknown granularity)
}

const UNIT_PLURAL = { day: 'days', week: 'weeks', month: 'months' };
const COARSER_HINT = { day: 'use Weekly or Monthly', week: 'use Monthly', month: '' };

// {day: {ok, reason}, week: …, month: …} for the given (exclusive-end) range. `ok` is
// MIN_BUCKETS <= count <= MAX_BUCKETS; a blocked entry carries a short `reason` for
// the button's title. `reason` is '' when ok.
export function allowedGranularities(startMs, endMs) {
  const out = {};
  for (const g of ['day', 'week', 'month']) {
    const count = bucketCountFor(startMs, endMs, g);
    if (count > MAX_BUCKETS) {
      const hint = COARSER_HINT[g];
      out[g] = { ok: false, reason: `Too many bars for this range${hint ? ` — ${hint}` : ''}` };
    } else if (count < MIN_BUCKETS) {
      out[g] = { ok: false, reason: `This range is under two ${UNIT_PLURAL[g]}` };
    } else {
      out[g] = { ok: true, reason: '' };
    }
  }
  return out;
}

const ORDER = ['day', 'week', 'month'];

// Keep `current` if it's allowed. Otherwise coarsen (day→week→month) when the problem
// is being over the cap, and refine (month→week→day) when the range would collapse to
// a single bar — implemented direction-agnostically by trying the NEAREST coarser
// option first, then the nearest finer one, then any allowed granularity at all. This
// is what stops a range change ever rendering an empty or one-bar chart. Never returns
// undefined: falls back to `current` if somehow nothing is allowed (this goes straight
// into a request).
export function coerceGranularity(current, allowed) {
  if (allowed[current]?.ok) return current;
  const idx = ORDER.indexOf(current);
  for (let i = idx + 1; i < ORDER.length; i += 1) if (allowed[ORDER[i]]?.ok) return ORDER[i];
  for (let i = idx - 1; i >= 0; i -= 1) if (allowed[ORDER[i]]?.ok) return ORDER[i];
  for (const g of ORDER) if (allowed[g]?.ok) return g;
  return current;
}

// Round-trip for the cm-usage-range localStorage key: {sel, from, to}. A stored
// PRESET re-resolves against today on next open ("Last 7 days" means the last 7 days
// now, not the week it was chosen) — this parser deliberately does not call
// resolvePreset itself, it only validates `sel` and leaves resolution to the caller.
// A stored CUSTOM range restores its exact dates. Anything unrecognised (garbage,
// wrong shape, a custom entry missing valid dates) falls back to the default.
export function parseStoredRange(raw) {
  if (typeof raw !== 'string') return { sel: DEFAULT_RANGE, from: null, to: null };
  let obj;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  if (!obj || typeof obj !== 'object') return { sel: DEFAULT_RANGE, from: null, to: null };
  const sel = obj.sel;
  if (sel === 'custom') {
    if (isDayKey(obj.from) && isDayKey(obj.to)) return { sel: 'custom', from: obj.from, to: obj.to };
    return { sel: DEFAULT_RANGE, from: null, to: null };
  }
  if (RANGE_PRESETS.some((p) => p.v === sel)) return { sel, from: null, to: null };
  return { sel: DEFAULT_RANGE, from: null, to: null };
}
export function serialiseRange(sel, from, to) {
  return sel === 'custom' ? JSON.stringify({ sel, from, to }) : JSON.stringify({ sel });
}
