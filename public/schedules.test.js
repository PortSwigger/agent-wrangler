import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileWhen, parseWhen, whenValid, cadenceSummary, formatNextRun, actionSummary,
} from './schedules.js';

// A fixed midday "now": 2026-06-24 12:00 local (a Wednesday).
const NOW = new Date(2026, 5, 24, 12, 0, 0, 0).getTime();
const HOUR = 3600e3;

test('compileWhen daily: M H * * * cron with the browser tz', () => {
  const when = compileWhen({ cadence: 'daily', time: '09:00' });
  assert.equal(when.kind, 'cron');
  assert.equal(when.cron, '0 9 * * *');
  assert.equal(typeof when.tz, 'string');
  assert.ok(when.tz.length); // some IANA zone (machine-dependent, just non-empty)
});

test('compileWhen daily weekdaysOnly: the 1-5 range dow (distinct from weekly commas)', () => {
  const when = compileWhen({ cadence: 'daily', time: '09:00', weekdaysOnly: true });
  assert.equal(when.cron, '0 9 * * 1-5');
});

test('compileWhen weekly: days sorted+deduped into the dow field (Sun=0..Sat=6)', () => {
  const when = compileWhen({ cadence: 'weekly', time: '08:05', days: [4, 1, 1] });
  assert.equal(when.cron, '5 8 * * 1,4');
});

test('compileWhen once: an absolute ISO instant, no cron/tz', () => {
  const when = compileWhen({ cadence: 'once', at: '2026-06-24T15:00' });
  assert.equal(when.kind, 'once');
  assert.equal(when.runAt, new Date(2026, 5, 24, 15, 0, 0, 0).toISOString());
  assert.equal(when.cron, undefined);
});

test('compileWhen: null when the picker is incomplete', () => {
  assert.equal(compileWhen({ cadence: 'once', at: '' }), null);
  assert.equal(compileWhen({ cadence: 'daily', time: 'bad' }), null);
  assert.equal(compileWhen({ cadence: 'weekly', time: '09:00', days: [] }), null);
  assert.equal(compileWhen(null), null);
});

test('parseWhen ↔ compileWhen round-trip (cron part) for daily, daily-weekdays and weekly', () => {
  const daily = { cadence: 'daily', time: '09:00', at: '', days: [], weekdaysOnly: false };
  assert.deepEqual(parseWhen(compileWhen(daily)), daily);
  // A daily-weekdays run round-trips back to Daily + the checkbox (not to weekly).
  const weekdays = { cadence: 'daily', time: '09:00', at: '', days: [], weekdaysOnly: true };
  assert.deepEqual(parseWhen(compileWhen(weekdays)), weekdays);
  const weekly = { cadence: 'weekly', time: '08:05', at: '', days: [1, 4], weekdaysOnly: false };
  assert.deepEqual(parseWhen(compileWhen(weekly)), weekly);
});

test('parseWhen once: pre-fills the datetime-local field from the instant', () => {
  const when = { kind: 'once', runAt: new Date(2026, 5, 24, 15, 0, 0, 0).toISOString() };
  const p = parseWhen(when);
  assert.equal(p.cadence, 'once');
  assert.equal(p.at, '2026-06-24T15:00');
});

test('parseWhen: a defaulted picker for a missing/garbage when', () => {
  assert.deepEqual(parseWhen(null), { cadence: 'once', at: '', time: '09:00', days: [], weekdaysOnly: false });
});

test('whenValid: once needs a future instant; daily/weekly need a time (+day)', () => {
  assert.equal(whenValid({ cadence: 'once', at: '2026-06-24T13:00' }, NOW), true);
  assert.equal(whenValid({ cadence: 'once', at: '2026-06-24T11:00' }, NOW), false); // past
  assert.equal(whenValid({ cadence: 'once', at: '' }, NOW), false);
  assert.equal(whenValid({ cadence: 'daily', time: '09:00' }, NOW), true);
  assert.equal(whenValid({ cadence: 'daily', time: '' }, NOW), false);
  assert.equal(whenValid({ cadence: 'weekly', time: '09:00', days: [1] }, NOW), true);
  assert.equal(whenValid({ cadence: 'weekly', time: '09:00', days: [] }, NOW), false);
});

test('cadenceSummary: friendly strings per cadence', () => {
  assert.equal(cadenceSummary(compileWhen({ cadence: 'daily', time: '09:00' })), 'Daily · 09:00');
  assert.equal(cadenceSummary(compileWhen({ cadence: 'daily', time: '09:00', weekdaysOnly: true })), 'Weekdays · 09:00');
  assert.equal(cadenceSummary(compileWhen({ cadence: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5] })), 'Weekdays · 09:00');
  assert.equal(cadenceSummary(compileWhen({ cadence: 'weekly', time: '08:00', days: [1, 4] })), 'Mon, Thu · 08:00');
  assert.equal(cadenceSummary(compileWhen({ cadence: 'weekly', time: '10:00', days: [0, 6] })), 'Weekends · 10:00');
  assert.equal(cadenceSummary(compileWhen({ cadence: 'weekly', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] })), 'Every day · 07:00');
  assert.equal(cadenceSummary({ kind: 'once', runAt: new Date(2026, 5, 24, 15, 0, 0, 0).toISOString() }), 'Once · 24 Jun 15:00');
  assert.equal(cadenceSummary(null), '');
});

test('formatNextRun: relative under an hour, then today/tomorrow/absolute', () => {
  assert.equal(formatNextRun(null, NOW), '');
  assert.equal(formatNextRun(new Date(NOW - HOUR).toISOString(), NOW), 'due now');
  assert.equal(formatNextRun(new Date(NOW + 5 * 60e3).toISOString(), NOW), 'in 5m');
  assert.equal(formatNextRun(new Date(2026, 5, 24, 18, 30, 0, 0).toISOString(), NOW), 'today 18:30');
  assert.equal(formatNextRun(new Date(2026, 5, 25, 9, 0, 0, 0).toISOString(), NOW), 'tomorrow 09:00');
  assert.equal(formatNextRun(new Date(2026, 5, 30, 9, 0, 0, 0).toISOString(), NOW), '30 Jun 09:00');
});

test('cadenceSummary: an unrecognised cron (range/step, e.g. from MCP) falls back to the raw expression', () => {
  assert.equal(cadenceSummary({ kind: 'cron', cron: '0 9 * * 1-3' }), 'Cron · 0 9 * * 1-3');
  assert.equal(cadenceSummary({ kind: 'cron', cron: '*/15 * * * *' }), 'Cron · */15 * * * *');
  // The picker's own crons summarise nicely: the daily-weekdays range and the
  // weekly comma-day list both read as "Weekdays".
  assert.equal(cadenceSummary({ kind: 'cron', cron: '0 9 * * 1-5' }), 'Weekdays · 09:00');
  assert.equal(cadenceSummary({ kind: 'cron', cron: '0 9 * * 1,2,3,4,5' }), 'Weekdays · 09:00');
});

test('actionSummary: dispatch shows the intent (or a fallback)', () => {
  assert.equal(actionSummary({ kind: 'dispatch', dispatch: { intent: 'ship it' } }), 'ship it');
  assert.equal(actionSummary({ kind: 'dispatch', dispatch: {} }), 'New session');
  // A legacy bare dispatch bag (no kind) is tolerated.
  assert.equal(actionSummary({ intent: 'legacy' }), 'legacy');
});

test('actionSummary: a session action resolves the target label and quotes the message', () => {
  const labelFor = (id) => (id === 'CARD1' ? 'Alpha' : null);
  assert.equal(actionSummary({ kind: 'session', sessionId: 'CARD1', message: 'check CI' }, labelFor), '→ Alpha: "check CI"');
  assert.equal(actionSummary({ kind: 'session', sessionId: 'CARD1', message: '' }, labelFor), '→ Alpha');
  // Unknown label falls back to the raw id.
  assert.equal(actionSummary({ kind: 'session', sessionId: 'CARD9', message: 'go' }, labelFor), '→ CARD9: "go"');
  assert.equal(actionSummary(null), '');
});
