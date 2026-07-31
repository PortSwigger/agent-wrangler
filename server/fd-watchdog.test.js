import test from 'node:test';
import assert from 'node:assert/strict';
import { countOpenFds, fdWatchdogDecision } from './fd-watchdog.js';

test('countOpenFds: returns the /dev/fd entry count', () => {
  assert.equal(countOpenFds(() => new Array(42)), 42);
});

test('countOpenFds: readdir throwing (no /dev/fd) → null, not a crash', () => {
  assert.equal(countOpenFds(() => { throw new Error('ENOENT'); }), null);
});

test('decision: below threshold → never warns', () => {
  assert.equal(fdWatchdogDecision({ count: 199, threshold: 200 }), null);
  assert.equal(fdWatchdogDecision({ count: 0, threshold: 200 }), null);
});

test('decision: unknown count (null) → never warns', () => {
  assert.equal(fdWatchdogDecision({ count: null, threshold: 200 }), null);
});

test('decision: first crossing of threshold warns at that level', () => {
  assert.equal(fdWatchdogDecision({ count: 200, threshold: 200, step: 50, lastWarnedAt: 0 }), 200);
  assert.equal(fdWatchdogDecision({ count: 230, threshold: 200, step: 50, lastWarnedAt: 0 }), 200);
});

test('decision: same level already warned → stays quiet', () => {
  assert.equal(fdWatchdogDecision({ count: 230, threshold: 200, step: 50, lastWarnedAt: 200 }), null);
});

test('decision: sustained growth escalates through further step levels', () => {
  assert.equal(fdWatchdogDecision({ count: 250, threshold: 200, step: 50, lastWarnedAt: 200 }), 250);
  assert.equal(fdWatchdogDecision({ count: 301, threshold: 200, step: 50, lastWarnedAt: 250 }), 300);
});

test('decision: a drop that does not cross back below threshold does not re-warn the same level', () => {
  assert.equal(fdWatchdogDecision({ count: 210, threshold: 200, step: 50, lastWarnedAt: 200 }), null);
});
