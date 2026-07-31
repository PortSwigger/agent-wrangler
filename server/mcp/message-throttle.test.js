import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageThrottle } from './message-throttle.js';

// A throttle with a controllable clock and small limits, so the layers are easy to
// exercise: cooldown 5s, window 30s, max 3 delivered messages per pair per window.
function make() {
  let t = 0;
  const throttle = createMessageThrottle({ cooldownMs: 5_000, windowMs: 30_000, maxPerWindow: 3, now: () => t });
  return { throttle, advance: (ms) => { t += ms; } };
}

// Only a committed (delivered) message counts toward the limits.
function deliver(throttle, from, to) {
  const g = throttle.check(from, to);
  if (g.ok) g.commit();
  return g;
}

test('first message on a pair is allowed', () => {
  const { throttle } = make();
  assert.equal(throttle.check('A', 'B').ok, true);
});

test('cooldown blocks a second message within the gap', () => {
  const { throttle, advance } = make();
  deliver(throttle, 'A', 'B');
  advance(2_000);
  const g = throttle.check('A', 'B');
  assert.equal(g.ok, false);
  assert.match(g.error, /wait ~3s/);
});

test('after the cooldown a message is allowed again', () => {
  const { throttle, advance } = make();
  deliver(throttle, 'A', 'B');
  advance(5_000);
  assert.equal(throttle.check('A', 'B').ok, true);
});

test('cooldown is per unordered pair — a reply in the other direction is also gated', () => {
  const { throttle, advance } = make();
  deliver(throttle, 'A', 'B');
  advance(1_000);
  const g = throttle.check('B', 'A');
  assert.equal(g.ok, false);
  assert.match(g.error, /wait/);
});

test('rate limit catches a loop that paces itself just above the cooldown', () => {
  const { throttle, advance } = make();
  // Three deliveries spaced 6s apart all clear the cooldown but fill the window.
  deliver(throttle, 'A', 'B'); advance(6_000);
  deliver(throttle, 'A', 'B'); advance(6_000);
  deliver(throttle, 'A', 'B'); advance(6_000);
  const g = throttle.check('A', 'B');
  assert.equal(g.ok, false);
  assert.match(g.error, /reply loop/);
});

test('old deliveries age out of the rolling window', () => {
  const { throttle, advance } = make();
  deliver(throttle, 'A', 'B'); advance(6_000);
  deliver(throttle, 'A', 'B'); advance(6_000);
  deliver(throttle, 'A', 'B');
  advance(31_000); // past the 30s window — all three expire
  assert.equal(throttle.check('A', 'B').ok, true);
});

test('separate pairs have independent budgets', () => {
  const { throttle } = make();
  deliver(throttle, 'A', 'B');
  assert.equal(throttle.check('A', 'C').ok, true);
});
