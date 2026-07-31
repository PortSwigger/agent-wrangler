import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snoozePhase, resolveUntil, wakeLabel, tileWeight,
  toDatetimeLocalValue, parseDatetimeLocal, customSnoozeValid, snoozeSetMessage,
  SNOOZE_STRIDE_PX, SNOOZE_DIVIDER_PX,
} from './snooze.js';

const HOUR = 3600e3;
// A fixed midday "now": 2026-06-12 12:00 local.
const NOW = new Date(2026, 5, 12, 12, 0, 0, 0).getTime();

test('snoozePhase: none / asleep / awake by until vs now', () => {
  assert.equal(snoozePhase(null, NOW), null);
  assert.equal(snoozePhase(undefined, NOW), null);
  assert.equal(snoozePhase({ until: NOW + HOUR }, NOW), 'asleep');
  assert.equal(snoozePhase({ until: NOW - 1 }, NOW), 'awake');
  assert.equal(snoozePhase({ until: NOW }, NOW), 'awake'); // boundary: now>=until
});

test('resolveUntil: relative presets', () => {
  assert.equal(resolveUntil('1h', NOW), NOW + HOUR);
  assert.equal(resolveUntil('4h', NOW), NOW + 4 * HOUR);
});

test('resolveUntil: tomorrow is 08:00 next calendar day', () => {
  const until = resolveUntil('tomorrow', NOW);
  const d = new Date(until);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5);
  assert.equal(d.getDate(), 13);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 0);
});

test('resolveUntil: next-week is the upcoming Monday at 08:00', () => {
  const until = resolveUntil('next-week', NOW);
  const d = new Date(until);
  assert.equal(d.getDay(), 1); // Monday
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 0);
  assert.ok(until > NOW);
  assert.ok(until - NOW <= 8 * 24 * HOUR); // within a week-and-a-bit
});

test('resolveUntil: an unknown choice returns null', () => {
  assert.equal(resolveUntil('whenever', NOW), null);
  assert.equal(resolveUntil(undefined, NOW), null);
});

test('wakeLabel: same-day counts down in minutes / hours+minutes', () => {
  assert.equal(wakeLabel(NOW + 45 * 60e3, NOW), '45m');
  assert.equal(wakeLabel(NOW + 60e3, NOW), '1m');
  assert.equal(wakeLabel(NOW + HOUR, NOW), '1h'); // exact hour -> no minutes
  assert.equal(wakeLabel(NOW + 4 * HOUR, NOW), '4h');
  assert.equal(wakeLabel(NOW + 90 * 60e3, NOW), '1h 30m');
  assert.equal(wakeLabel(NOW + (2 * HOUR + 5 * 60e3), NOW), '2h 5m');
});

test('wakeLabel: cross-day keeps an absolute day anchor', () => {
  assert.equal(wakeLabel(resolveUntil('tomorrow', NOW), NOW), 'tomorrow 8am');
});

test('toDatetimeLocalValue: local "YYYY-MM-DDTHH:mm", zero-padded', () => {
  // 2026-06-09 08:05 local -> single-digit month/day/hour/minute all padded.
  const ms = new Date(2026, 5, 9, 8, 5, 0, 0).getTime();
  assert.equal(toDatetimeLocalValue(ms), '2026-06-09T08:05');
  // Tomorrow-8am preset round-trips through the formatter.
  assert.equal(toDatetimeLocalValue(resolveUntil('tomorrow', NOW)), '2026-06-13T08:00');
});

test('parseDatetimeLocal: parses local time, rejects empty/garbage', () => {
  assert.equal(parseDatetimeLocal('2026-06-13T08:00'), new Date(2026, 5, 13, 8, 0, 0, 0).getTime());
  assert.equal(parseDatetimeLocal(''), null);
  assert.equal(parseDatetimeLocal('not-a-date'), null);
  assert.equal(parseDatetimeLocal(null), null);
});

test('toDatetimeLocalValue/parseDatetimeLocal round-trip to the minute', () => {
  const ms = new Date(2026, 11, 31, 23, 59, 0, 0).getTime();
  assert.equal(parseDatetimeLocal(toDatetimeLocalValue(ms)), ms);
});

test('customSnoozeValid: true only for a parseable future time', () => {
  assert.equal(customSnoozeValid(toDatetimeLocalValue(NOW + HOUR), NOW), true);
  assert.equal(customSnoozeValid(toDatetimeLocalValue(NOW - HOUR), NOW), false);
  assert.equal(customSnoozeValid(toDatetimeLocalValue(NOW), NOW), false); // boundary: not future
  assert.equal(customSnoozeValid('', NOW), false);
  assert.equal(customSnoozeValid('garbage', NOW), false);
});

test('snoozeSetMessage: includes a trimmed comment when one is given (custom modal)', () => {
  assert.deepEqual(
    snoozeSetMessage('S1', 123, '  finish the refactor  '),
    { type: 'snooze-set', sessionId: 'S1', until: 123, comment: 'finish the refactor' },
  );
});

test('snoozeSetMessage: omits the comment key when blank or whitespace-only', () => {
  assert.deepEqual(snoozeSetMessage('S1', 123, '   '), { type: 'snooze-set', sessionId: 'S1', until: 123 });
  assert.deepEqual(snoozeSetMessage('S1', 123, ''), { type: 'snooze-set', sessionId: 'S1', until: 123 });
});

test('snoozeSetMessage: presets carry no comment (no comment argument)', () => {
  const msg = snoozeSetMessage('S1', 123);
  assert.deepEqual(msg, { type: 'snooze-set', sessionId: 'S1', until: 123 });
  assert.ok(!('comment' in msg));
});

test('tileWeight: snoozed rows counted at reduced weight', () => {
  const stride = 80;
  // 2 active only -> exactly 2 card-equivalents.
  assert.equal(tileWeight({ activeCount: 2, snoozedCount: 0, cardStride: stride }), 2);
  // 2 active + 3 snoozed -> 2 + divider + 3*snoozeStride, in card units.
  const expected = (2 * stride + SNOOZE_DIVIDER_PX + 3 * SNOOZE_STRIDE_PX) / stride;
  assert.equal(tileWeight({ activeCount: 2, snoozedCount: 3, cardStride: stride }), expected);
  // No snoozed -> no divider added.
  assert.equal(tileWeight({ activeCount: 1, snoozedCount: 0, cardStride: stride }), 1);
});
