import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANGE_PRESETS, DEFAULT_RANGE, resolvePreset, MIN_BUCKETS, MAX_BUCKETS,
  bucketCountFor, allowedGranularities, coerceGranularity, parseStoredRange, serialiseRange,
} from './usage-range.js';

const NOW = Date.parse('2026-07-16T15:00:00.000Z'); // mid-July, mid-day (Thursday)
const DAY_MS = 86_400_000;

test('DEFAULT_RANGE matches the pre-existing 30-bucket Daily default', () => {
  assert.equal(DEFAULT_RANGE, 'last-30');
  assert.ok(RANGE_PRESETS.some((p) => p.v === DEFAULT_RANGE));
});

test('resolvePreset: last-7 / last-30 / last-90 cover N days ending today', () => {
  assert.deepEqual(resolvePreset('last-7', NOW), { start: '2026-07-10', end: '2026-07-16' });
  assert.deepEqual(resolvePreset('last-30', NOW), { start: '2026-06-17', end: '2026-07-16' });
  assert.deepEqual(resolvePreset('last-90', NOW), { start: '2026-04-18', end: '2026-07-16' });
});

test('resolvePreset: this-month / last-month at a mid-month boundary', () => {
  assert.deepEqual(resolvePreset('this-month', NOW), { start: '2026-07-01', end: '2026-07-16' });
  assert.deepEqual(resolvePreset('last-month', NOW), { start: '2026-06-01', end: '2026-06-30' });
});

test('resolvePreset: last-month wraps the YEAR boundary correctly (January)', () => {
  const jan = Date.parse('2026-01-15T00:00:00.000Z');
  assert.deepEqual(resolvePreset('last-month', jan), { start: '2025-12-01', end: '2025-12-31' });
});

test('resolvePreset: this-year', () => {
  assert.deepEqual(resolvePreset('this-year', NOW), { start: '2026-01-01', end: '2026-07-16' });
});

test('resolvePreset: all-time and custom both resolve to fully unbounded', () => {
  assert.deepEqual(resolvePreset('all-time', NOW), { start: null, end: null });
  assert.deepEqual(resolvePreset('custom', NOW), { start: null, end: null });
});

test('resolvePreset: an unrecognised value is treated like custom/all-time (unbounded), not thrown', () => {
  assert.deepEqual(resolvePreset('bogus', NOW), { start: null, end: null });
});

test('bucketCountFor agrees with a hand-counted month span (guards drift vs windowBetween)', () => {
  // Jan 1 (inclusive) through the exclusive end of Mar (i.e. through Mar 31 inclusive):
  // Jan, Feb, Mar = 3 calendar months.
  const start = Date.UTC(2026, 0, 1);
  const end = Date.UTC(2026, 3, 1); // exclusive: April 1
  assert.equal(bucketCountFor(start, end, 'month'), 3);
  // A single day: day=1, week=1, month=1.
  const d0 = Date.UTC(2026, 6, 10);
  const d1 = d0 + DAY_MS;
  assert.equal(bucketCountFor(d0, d1, 'day'), 1);
  assert.equal(bucketCountFor(d0, d1, 'week'), 1);
  assert.equal(bucketCountFor(d0, d1, 'month'), 1);
});

test('allowedGranularities: a 10-day range excludes Monthly (under MIN_BUCKETS)', () => {
  const start = Date.UTC(2026, 6, 1);
  const end = start + 10 * DAY_MS;
  const allowed = allowedGranularities(start, end);
  assert.equal(allowed.day.ok, true);
  assert.equal(allowed.week.ok, true);
  assert.equal(allowed.month.ok, false);
  assert.match(allowed.month.reason, /under two months/);
});

test('allowedGranularities: a 3-year range excludes Daily (over MAX_BUCKETS)', () => {
  const start = Date.UTC(2023, 0, 1);
  const end = Date.UTC(2026, 0, 1); // 3 years
  const allowed = allowedGranularities(start, end);
  assert.equal(allowed.day.ok, false);
  assert.match(allowed.day.reason, /Too many bars/);
  assert.equal(allowed.week.ok, true);
  assert.equal(allowed.month.ok, true);
});

test('allowedGranularities: reasons are empty strings when ok', () => {
  const start = Date.UTC(2026, 6, 1);
  const end = start + 30 * DAY_MS;
  const allowed = allowedGranularities(start, end);
  for (const g of ['day', 'week', 'month']) {
    if (allowed[g].ok) assert.equal(allowed[g].reason, '');
  }
});

test('coerceGranularity: no-op when current is already allowed', () => {
  const allowed = { day: { ok: true, reason: '' }, week: { ok: true, reason: '' }, month: { ok: true, reason: '' } };
  assert.equal(coerceGranularity('day', allowed), 'day');
  assert.equal(coerceGranularity('week', allowed), 'week');
});

test('coerceGranularity: coarsens (day -> week/month) when over the cap', () => {
  const allowed = allowedGranularities(Date.UTC(2023, 0, 1), Date.UTC(2026, 0, 1)); // 3 years: day blocked
  const next = coerceGranularity('day', allowed);
  assert.notEqual(next, 'day');
  assert.ok(allowed[next].ok);
});

test('coerceGranularity: refines (month -> week/day) off a single/too-few bar', () => {
  const allowed = allowedGranularities(Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 1) + 10 * DAY_MS); // 10 days: month blocked
  const next = coerceGranularity('month', allowed);
  assert.notEqual(next, 'month');
  assert.ok(allowed[next].ok);
});

test('coerceGranularity: falls back to current if nothing is allowed at all', () => {
  const allowed = { day: { ok: false, reason: 'x' }, week: { ok: false, reason: 'x' }, month: { ok: false, reason: 'x' } };
  assert.equal(coerceGranularity('day', allowed), 'day');
  assert.equal(coerceGranularity('month', allowed), 'month');
});

test('parseStoredRange / serialiseRange round-trip a preset', () => {
  const raw = serialiseRange('last-7', null, null);
  assert.deepEqual(parseStoredRange(raw), { sel: 'last-7', from: null, to: null });
});

test('parseStoredRange / serialiseRange round-trip a custom range with exact dates', () => {
  const raw = serialiseRange('custom', '2026-01-01', '2026-02-15');
  assert.deepEqual(parseStoredRange(raw), { sel: 'custom', from: '2026-01-01', to: '2026-02-15' });
});

test('parseStoredRange: garbage input falls back to the default', () => {
  assert.deepEqual(parseStoredRange('not json'), { sel: DEFAULT_RANGE, from: null, to: null });
  assert.deepEqual(parseStoredRange(null), { sel: DEFAULT_RANGE, from: null, to: null });
  assert.deepEqual(parseStoredRange(undefined), { sel: DEFAULT_RANGE, from: null, to: null });
  assert.deepEqual(parseStoredRange('{}'), { sel: DEFAULT_RANGE, from: null, to: null });
  assert.deepEqual(parseStoredRange(JSON.stringify({ sel: 'not-a-real-preset' })), { sel: DEFAULT_RANGE, from: null, to: null });
});

test('parseStoredRange: a custom entry with missing/invalid dates falls back to the default', () => {
  assert.deepEqual(parseStoredRange(JSON.stringify({ sel: 'custom', from: null, to: null })), { sel: DEFAULT_RANGE, from: null, to: null });
  assert.deepEqual(parseStoredRange(JSON.stringify({ sel: 'custom', from: 'nope', to: '2026-01-01' })), { sel: DEFAULT_RANGE, from: null, to: null });
});

test('MIN_BUCKETS/MAX_BUCKETS are the documented values', () => {
  assert.equal(MIN_BUCKETS, 2);
  assert.equal(MAX_BUCKETS, 400);
});
