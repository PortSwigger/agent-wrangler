import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunAt, isValidCron } from './cron-next.js';

// All cron cases evaluate in an explicit tz (UTC) so the expected instants are
// machine-independent; the store always stores tz alongside a cron `when`.
const at = (...args) => Date.UTC(...args);

test('nextRunAt cron: daily fires the same day when fromMs is before the slot', () => {
  const from = at(2026, 5, 24, 6, 0, 0); // Wed 06:00 UTC, before 09:00
  assert.equal(nextRunAt({ kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, from), at(2026, 5, 24, 9, 0, 0));
});

test('nextRunAt cron: daily wraps to the next day once the slot has passed', () => {
  const from = at(2026, 5, 24, 10, 0, 0); // Wed 10:00 UTC, after 09:00
  assert.equal(nextRunAt({ kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, from), at(2026, 5, 25, 9, 0, 0));
});

test('nextRunAt cron: weekday set picks the next listed day', () => {
  // Mon,Thu 08:00 from a Tuesday → the upcoming Thursday (not Monday).
  const from = at(2026, 5, 23, 10, 0, 0); // Tue
  assert.equal(nextRunAt({ kind: 'cron', cron: '0 8 * * 1,4', tz: 'UTC' }, from), at(2026, 5, 25, 8, 0, 0));
});

test('nextRunAt cron: occurrence is strictly after fromMs (no re-fire on the boundary)', () => {
  const onSlot = at(2026, 5, 24, 9, 0, 0); // exactly the cron time
  assert.equal(nextRunAt({ kind: 'cron', cron: '0 9 * * *', tz: 'UTC' }, onSlot), at(2026, 5, 25, 9, 0, 0));
});

test('nextRunAt once: returns the fixed instant regardless of fromMs', () => {
  const when = { kind: 'once', runAt: '2026-06-24T15:00:00.000Z' };
  const fixed = Date.parse(when.runAt);
  assert.equal(nextRunAt(when, at(2020, 0, 1)), fixed);
  assert.equal(nextRunAt(when, at(2030, 0, 1)), fixed); // even when fromMs is past it
});

test('nextRunAt: null for unknown kind, unparseable once, and unparseable cron', () => {
  assert.equal(nextRunAt({ kind: 'weekly' }, 0), null);
  assert.equal(nextRunAt({ kind: 'once', runAt: 'not-a-date' }, 0), null);
  assert.equal(nextRunAt({ kind: 'cron', cron: 'nonsense' }, 0), null);
  assert.equal(nextRunAt(null, 0), null);
});

test('isValidCron: accepts real expressions, rejects empty/garbage', () => {
  assert.equal(isValidCron('0 9 * * 1-5'), true);
  assert.equal(isValidCron('*/5 * * * *'), true);
  assert.equal(isValidCron(''), false);
  assert.equal(isValidCron('   '), false);
  assert.equal(isValidCron('not a cron'), false);
  assert.equal(isValidCron(null), false);
});
