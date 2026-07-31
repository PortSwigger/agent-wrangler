// Pure schedule helpers, split out of app.js so they're unit-testable without a
// DOM (model: snooze.js / workflow.js). The friendly picker (One-off / Daily /
// Weekly-on-days) compiles to the `when` the server stores: a recurring cadence
// becomes a cron string evaluated server-side via cron-parser; a one-off stores an
// absolute instant (computed in the browser, so timezone is moot for it). We reuse
// snooze.js's datetime-local helpers for the one-off field.
import { toDatetimeLocalValue, parseDatetimeLocal } from './snooze.js';

const pad2 = (n) => String(n).padStart(2, '0');
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // cron dow: Sun=0..Sat=6
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = [1, 2, 3, 4, 5];

// The browser's IANA zone, stored alongside a cron so "09:00" stays 09:00 across
// DST (the wrangler is loopback-only, so this is also the server's zone in practice).
function resolveTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// "HH:mm" → { h, m } or null. The Daily/Weekly time input emits this shape.
function parseHm(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

// Clean a weekday list: integers 0..6, de-duped, ascending — so the cron dow field
// and the summary are stable regardless of click order.
function normaliseDays(days) {
  if (!Array.isArray(days)) return [];
  return [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

const isWeekdays = (days) => days.length === 5 && WEEKDAYS.every((d) => days.includes(d));

// The canonical dow field a "Daily, weekdays only" run compiles to — the range form
// `1-5`, kept distinct from the weekly comma form (`1,2,3,4,5`) so each cadence
// round-trips back to its own picker mode (both fire identically Mon–Fri).
const WEEKDAYS_DOW = '1-5';

// True iff a cron is the exact shape our picker writes (`M H * * *`, `M H * * 1-5`,
// or `M H * * d,d`, integer minute/hour, every-day-of-month/month). cadenceSummary
// trusts parseWhen only for these; a cron from the MCP tool or a hand edit (other
// ranges, steps, day-of-month) gets the raw-expression fallback instead of a wrong
// summary.
function isPickerCron(cron) {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const [min, hour, dom, mon, dow] = f;
  const isInt = (s, max) => /^\d+$/.test(s) && Number(s) <= max;
  if (!isInt(min, 59) || !isInt(hour, 23) || dom !== '*' || mon !== '*') return false;
  return dow === '*' || dow === WEEKDAYS_DOW || dow.split(',').every((d) => isInt(d, 6));
}

// Picker → the server's `when` object, or null when the picker is incomplete
// (caller gates Save on whenValid). `once` → an absolute ISO instant; `daily` /
// `weekly` → a cron string + tz.
export function compileWhen(picker) {
  if (!picker) return null;
  if (picker.cadence === 'once') {
    const ms = parseDatetimeLocal(picker.at);
    return ms == null ? null : { kind: 'once', runAt: new Date(ms).toISOString() };
  }
  const hm = parseHm(picker.time);
  if (!hm) return null;
  const tz = resolveTz();
  if (picker.cadence === 'daily') {
    const dow = picker.weekdaysOnly ? WEEKDAYS_DOW : '*';
    return { kind: 'cron', cron: `${hm.m} ${hm.h} * * ${dow}`, tz };
  }
  if (picker.cadence === 'weekly') {
    const days = normaliseDays(picker.days);
    if (!days.length) return null;
    return { kind: 'cron', cron: `${hm.m} ${hm.h} * * ${days.join(',')}`, tz };
  }
  return null;
}

// Inverse of compileWhen, to pre-fill the picker when editing. Reads only the
// minute/hour/dow fields of our own generated cron (it never has to parse arbitrary
// crons — the picker is the only writer). tz is dropped (recomputed on next save).
export function parseWhen(when) {
  const base = { cadence: 'once', at: '', time: '09:00', days: [], weekdaysOnly: false };
  if (!when || typeof when !== 'object') return base;
  if (when.kind === 'once') {
    const ms = Date.parse(when.runAt);
    return { ...base, cadence: 'once', at: Number.isNaN(ms) ? '' : toDatetimeLocalValue(ms) };
  }
  if (when.kind === 'cron') {
    const [min, hour, , , dow] = String(when.cron || '').trim().split(/\s+/);
    const h = Number(hour);
    const m = Number(min);
    const time = Number.isInteger(h) && Number.isInteger(m) ? `${pad2(h)}:${pad2(m)}` : '09:00';
    // The range form `1-5` is the daily-weekdays variant (checked before the comma
    // branch, which can't parse a range); a comma day-list is a weekly cadence.
    if (dow === WEEKDAYS_DOW) {
      return { ...base, cadence: 'daily', time, weekdaysOnly: true };
    }
    if (dow && dow !== '*') {
      return { ...base, cadence: 'weekly', time, days: normaliseDays(dow.split(',').map(Number)) };
    }
    return { ...base, cadence: 'daily', time };
  }
  return base;
}

// True iff the picker is complete enough to save (mirrors snooze's customSnoozeValid):
// a one-off needs a future instant; daily/weekly need a valid time (+ ≥1 day weekly).
export function whenValid(picker, now = Date.now()) {
  if (!picker) return false;
  if (picker.cadence === 'once') {
    const ms = parseDatetimeLocal(picker.at);
    return ms != null && ms > now;
  }
  if (picker.cadence === 'daily') return parseHm(picker.time) != null;
  if (picker.cadence === 'weekly') return parseHm(picker.time) != null && normaliseDays(picker.days).length > 0;
  return false;
}

function formatDateTime(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Human cadence for a schedule row ("Weekdays · 09:00", "Daily · 09:00",
// "Mon, Thu · 08:00", "Once · 24 Jun 15:00").
export function cadenceSummary(when) {
  if (!when || typeof when !== 'object') return '';
  if (when.kind === 'once') {
    const ms = Date.parse(when.runAt);
    return Number.isNaN(ms) ? 'Once' : `Once · ${formatDateTime(ms)}`;
  }
  if (when.kind === 'cron') {
    // A cron our picker didn't author (ranges/steps/day-of-month, e.g. from the MCP
    // tool) can't be mapped to the Daily/Weekly vocabulary — show it raw rather than
    // a wrong or blank summary.
    if (!isPickerCron(when.cron)) return `Cron · ${String(when.cron || '').trim()}`;
    const p = parseWhen(when);
    if (p.cadence === 'daily') return `${p.weekdaysOnly ? 'Weekdays' : 'Daily'} · ${p.time}`;
    const days = p.days;
    if (days.length === 7) return `Every day · ${p.time}`;
    if (isWeekdays(days)) return `Weekdays · ${p.time}`;
    if (days.length === 2 && days.includes(0) && days.includes(6)) return `Weekends · ${p.time}`;
    return `${days.map((d) => DAY_LABELS[d]).join(', ')} · ${p.time}`;
  }
  return '';
}

// One-line description of what a schedule's action does, for the panel meta line.
// `labelFor(sessionId)` resolves a target session's friendly label (the board has
// it; pass a stub in tests) — falls back to the raw id. Pure, so it's unit-tested
// without the DOM. A legacy schedule with a bare top-level `dispatch` is handled by
// callers normalising to `action` first, but tolerate it here too.
export function actionSummary(action, labelFor = () => null) {
  const a = action && action.kind ? action : (action ? { kind: 'dispatch', dispatch: action } : null);
  if (!a) return '';
  if (a.kind === 'dispatch') return (a.dispatch?.intent || '').trim() || 'New session';
  // A session action resumes-or-messages the target by its liveness, so the summary
  // is verb-agnostic: just the target (with the message quoted when present).
  const who = labelFor(a.sessionId) || a.sessionId || 'session';
  const msg = (a.message || '').trim();
  return msg ? `→ ${who}: "${msg}"` : `→ ${who}`;
}

// Compact next-fire label for a row ("in 5m", "today 09:00", "tomorrow 09:00",
// "24 Jun 15:00"). '' for an absent/unparseable nextRunAt (a disabled schedule).
export function formatNextRun(nextRunAt, now = Date.now()) {
  const ms = typeof nextRunAt === 'number' ? nextRunAt : Date.parse(nextRunAt);
  if (nextRunAt == null || Number.isNaN(ms)) return '';
  const delta = ms - now;
  if (delta <= 0) return 'due now';
  const mins = Math.round(delta / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hm = `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = new Date(ms).toDateString() === tomorrow.toDateString();
  if (sameDay) return `today ${hm}`;
  if (isTomorrow) return `tomorrow ${hm}`;
  return formatDateTime(ms);
}
