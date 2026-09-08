import test from 'node:test';
import assert from 'node:assert/strict';
import { heapUsage, heapWatchdogDecision, startHeapWatchdog } from './heap-watchdog.js';

const stats = (used, limit) => () => ({ used_heap_size: used, heap_size_limit: limit });

test('heapUsage: reports used/limit as a percentage', () => {
  const u = heapUsage(stats(500, 1000));
  assert.equal(u.pct, 50);
  assert.equal(u.used, 500);
  assert.equal(u.limit, 1000);
});

test('heapUsage: unusable v8 stats → null, not a crash and not "healthy"', () => {
  assert.equal(heapUsage(() => { throw new Error('nope'); }), null);
  assert.equal(heapUsage(() => ({})), null);
  assert.equal(heapUsage(() => ({ heap_size_limit: 0, used_heap_size: 10 })), null);
});

test('decision: below the lowest level → never warns', () => {
  assert.equal(heapWatchdogDecision({ pct: 49.9 }), null);
  assert.equal(heapWatchdogDecision({ pct: 0 }), null);
});

test('decision: unknown reading (null) → never warns', () => {
  assert.equal(heapWatchdogDecision({ pct: null }), null);
});

test('decision: first crossing warns at the highest level crossed', () => {
  assert.equal(heapWatchdogDecision({ pct: 50 }), 50);
  assert.equal(heapWatchdogDecision({ pct: 60 }), 50);
  // A jump straight past two levels reports the worse one, not the first.
  assert.equal(heapWatchdogDecision({ pct: 92, lastWarnedAt: 0 }), 90);
});

test('decision: sitting at a level already warned → stays quiet', () => {
  assert.equal(heapWatchdogDecision({ pct: 60, lastWarnedAt: 50 }), null);
  assert.equal(heapWatchdogDecision({ pct: 74.9, lastWarnedAt: 50 }), null);
});

test('decision: sustained growth escalates through the levels', () => {
  assert.equal(heapWatchdogDecision({ pct: 75, lastWarnedAt: 50 }), 75);
  assert.equal(heapWatchdogDecision({ pct: 90, lastWarnedAt: 75 }), 90);
});

test('decision: never re-warns a level after the heap eases back a little', () => {
  assert.equal(heapWatchdogDecision({ pct: 76, lastWarnedAt: 90 }), null);
});

test('decision: honours custom levels', () => {
  assert.equal(heapWatchdogDecision({ pct: 30, levels: [25, 80] }), 25);
  assert.equal(heapWatchdogDecision({ pct: 20, levels: [25, 80] }), null);
});

// The whole point of the edge-triggering: a healthy server must print nothing,
// ever, and a climbing one must print once per level rather than once per poll.
test('startHeapWatchdog: silent while healthy, one warning per level crossed', async () => {
  const seen = [];
  const warned = [];
  const realWarn = console.warn;
  console.warn = (m) => warned.push(m);
  let pct = 10;
  try {
    const timer = startHeapWatchdog({
      intervalMs: 1,
      onAlert: (a) => seen.push(a.level),
      getStats: () => ({ used_heap_size: pct, heap_size_limit: 100 }),
    });
    const tick = () => new Promise((r) => setTimeout(r, 15));
    await tick();
    assert.deepEqual(seen, [], 'a healthy heap logged nothing');

    pct = 55; await tick();          // crosses 50
    pct = 60; await tick();          // still at 50 — must not repeat
    pct = 80; await tick();          // crosses 75
    pct = 95; await tick();          // crosses 90
    assert.deepEqual(seen, [50, 75, 90]);
    assert.equal(warned.length, 3, 'one console line per level, not per poll');
    assert.match(warned[2], /crossed 90%/);
    timer.close();
  } finally {
    console.warn = realWarn;
  }
});

test('startHeapWatchdog: dropping back under the lowest level re-arms and clears', async () => {
  const seen = [];
  const cleared = [];
  const realWarn = console.warn;
  console.warn = () => {};
  let pct = 55;
  try {
    const timer = startHeapWatchdog({
      intervalMs: 1,
      onAlert: (a) => seen.push(a.level),
      onClear: () => cleared.push(true),
      getStats: () => ({ used_heap_size: pct, heap_size_limit: 100 }),
    });
    const tick = () => new Promise((r) => setTimeout(r, 15));
    await tick();                    // crosses 50
    pct = 10; await tick();          // reclaimed → clears
    pct = 55; await tick();          // climbs again → must warn again
    assert.deepEqual(seen, [50, 50]);
    assert.equal(cleared.length, 1);
    timer.close();
  } finally {
    console.warn = realWarn;
  }
});
