import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageThrottle } from './message-throttle.js';

// A throttle with a controllable clock and a small window, so the limit is easy to
// exercise: 30s window, max 3 delivered messages per pair per window.
function make() {
  let t = 0;
  const throttle = createMessageThrottle({ windowMs: 30_000, maxPerWindow: 3, now: () => t });
  return { throttle, advance: (ms) => { t += ms; } };
}

// Only a committed (delivered) message counts toward the limit.
function deliver(throttle, from, to) {
  const g = throttle.check(from, to);
  if (g.ok) g.commit();
  return g;
}

test('first message on a pair is allowed', () => {
  const { throttle } = make();
  assert.equal(throttle.check('A', 'B').ok, true);
});

test('no cooldown — a second message right after the first is allowed (batching handles a burst)', () => {
  const { throttle, advance } = make();
  deliver(throttle, 'A', 'B');
  advance(1); // effectively immediate
  assert.equal(throttle.check('A', 'B').ok, true);
});

test('rate limit catches a loop that paces itself steadily', () => {
  const { throttle, advance } = make();
  deliver(throttle, 'A', 'B'); advance(6_000);
  deliver(throttle, 'A', 'B'); advance(6_000);
  deliver(throttle, 'A', 'B'); advance(6_000);
  const g = throttle.check('A', 'B');
  assert.equal(g.ok, false);
  assert.match(g.error, /reply loop/);
});

test('the rate-limit error carries the acknowledge-loop guidance the cooldown used to own', () => {
  const { throttle } = make();
  for (let i = 0; i < 3; i++) deliver(throttle, 'A', 'B');
  const g = throttle.check('A', 'B');
  assert.match(g.error, /do not reply at all/);
});

test('rate limit is per unordered pair — a reply in the other direction shares the same budget', () => {
  const { throttle } = make();
  for (let i = 0; i < 3; i++) deliver(throttle, 'A', 'B');
  const g = throttle.check('B', 'A');
  assert.equal(g.ok, false);
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

test('a rejected attempt does not extend the window (only commit() records it)', () => {
  const { throttle } = make();
  for (let i = 0; i < 3; i++) deliver(throttle, 'A', 'B');
  throttle.check('A', 'B'); // rejected, not committed
  throttle.check('A', 'B'); // rejected, not committed
  assert.equal(throttle.check('A', 'B').ok, false); // still just the original 3
});
