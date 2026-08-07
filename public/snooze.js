// Pure snooze logic, split out of app.js so it can be unit-tested without a DOM.
// The browser loads this as a module (it also pins exports onto window for the
// classic app.js script); node imports it directly. See search-browse.js for the
// same split-out-pure-logic pattern.

const HOUR = 3600e3;

// Minimized-row geometry, in px, feeding the tile-span weight. PLACEHOLDERS to be
// re-measured off the real rendered .snoozed-row / .snooze-divider during Task 6,
// exactly as CARD_STRIDE_PX in app.js was measured off the DOM. A snoozed row is
// roughly half an active card; the divider is a one-time per-tile cost.
export const SNOOZE_STRIDE_PX = 34;
export const SNOOZE_DIVIDER_PX = 18;

// Three-way phase from the stored snooze and the current time. null = not snoozed.
// awake at the boundary (now >= until) so a fired snooze never gets stuck asleep.
export function snoozePhase(snooze, now) {
  if (!snooze || typeof snooze.until !== 'number') return null;
  return now >= snooze.until ? 'awake' : 'asleep';
}

// Resolve a preset to an absolute `until` (epoch ms), or null for an unknown
// choice. Presets: '1h' | '4h' | 'tomorrow' | 'next-week'.
export function resolveUntil(choice, now) {
  if (choice === '1h') return now + HOUR;
  if (choice === '4h') return now + 4 * HOUR;
  if (choice === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  }
  if (choice === 'next-week') {
    // The upcoming Monday at 08:00; from a Monday, the Monday a week out.
    const d = new Date(now);
    const delta = ((1 - d.getDay() + 7) % 7) || 7;
    d.setDate(d.getDate() + delta);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  }
  return null;
}

// Compact chip label for the wake time. Same-day -> "Nh" rounded up; otherwise a
// day-anchored label. Kept deliberately small for the greyed minimized row.
export function wakeLabel(until, now) {
  const ms = until - now;
  if (ms <= 0) return 'now';
  // Same-day wakes count down (re-rendered every few seconds): minutes under an
  // hour, then "Hh Mm" / "Hh". Cross-day wakes keep an absolute day anchor —
  // "tomorrow 8am" reads better than "18h" and doesn't need to tick.
  const sameDay = new Date(until).toDateString() === new Date(now).toDateString();
  if (sameDay) {
    const mins = Math.ceil(ms / 60e3);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = new Date(until);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const prefix = d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : `${d.getDate()}/${d.getMonth() + 1}`;
  const h = d.getHours();
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return d.getMinutes() === 0 ? `${prefix} ${h12}${ampm}` : `${prefix} ${h12}:${String(d.getMinutes()).padStart(2, '0')}${ampm}`;
}

// Format an epoch-ms instant as a `datetime-local` input value — local-time
// "YYYY-MM-DDTHH:mm", zero-padded. The input carries no timezone, so this stays
// in local time to match every other wake-time computation here.
export function toDatetimeLocalValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Parse a `datetime-local` value back to epoch ms (local time), or null for an
// empty/unparseable value. A bare datetime-local string has no timezone, so
// `new Date` reads it as local — the inverse of toDatetimeLocalValue.
export function parseDatetimeLocal(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// The custom-snooze validity rule, kept out of the DOM and under test: a
// parseable instant strictly in the future.
export function customSnoozeValid(value, now) {
  const ms = parseDatetimeLocal(value);
  return ms !== null && ms > now;
}

// Build the `snooze-set` payload. The optional agent comment (custom modal only —
// presets pass none) is trimmed and the key omitted when blank, so a stored
// snooze never carries an empty comment. Kept pure so both call sites (the custom
// modal and the instant presets) stay DOM-free and under test.
export function snoozeSetMessage(sessionId, until, comment = '') {
  const msg = { type: 'snooze-set', sessionId, until };
  const c = (comment || '').trim();
  if (c) msg.comment = c;
  return msg;
}

// Tile height as fractional card-equivalents: active cards full weight, snoozed
// rows a fraction (their px height / card stride), plus a one-time divider cost
// when any are snoozed. Feeds rowSpan(weight, perRow) in app.js.
export function tileWeight({ activeCount, snoozedCount, cardStride }) {
  const px = activeCount * cardStride
    + (snoozedCount > 0 ? SNOOZE_DIVIDER_PX : 0)
    + snoozedCount * SNOOZE_STRIDE_PX;
  return px / cardStride;
}

