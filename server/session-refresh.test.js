import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOnOlderCode, nextSessionToRefresh, REFRESH_MIN_IDLE_MS } from './session-refresh.js';

const now = 10_000_000;
const stale = (over = {}) => ({
  sessionId: 's1', tmux: 'aw-1', status: 'idle', hasBackgroundShell: false, snooze: null,
  launchedCodeVersion: 'old', lastActivity: now - REFRESH_MIN_IDLE_MS - 1, ...over,
});

test('a live session launched on a different commit is on older code', () => {
  assert.equal(isOnOlderCode(stale(), 'new'), true);
  assert.equal(isOnOlderCode(stale({ launchedCodeVersion: 'new' }), 'new'), false);
  assert.equal(isOnOlderCode(stale({ launchedCodeVersion: null }), 'new'), false, 'adopted or pre-feature sessions are unknown, not stale');
  assert.equal(isOnOlderCode(stale({ tmux: null }), 'new'), false, 'a dormant card relaunches on current code anyway');
  assert.equal(isOnOlderCode(stale(), null), false);
});

test('only an idle, unattended, long-quiet stale session is picked', () => {
  const pick = (s, opts = {}) => nextSessionToRefresh([s], { codeVersion: 'new', now, ...opts });
  assert.equal(pick(stale())?.sessionId, 's1');
  assert.equal(pick(stale({ status: 'working' })), null);
  assert.equal(pick(stale({ status: 'needs-you' })), null);
  assert.equal(pick(stale({ hasBackgroundShell: true })), null);
  assert.equal(pick(stale({ snooze: { until: now + 1 } })), null);
  assert.equal(pick(stale({ lastActivity: now - 1000 })), null);
  assert.equal(pick(stale({ lastActivity: null })), null, 'never messaged, so there is no conversation to resume');
  assert.equal(pick(stale(), { attached: new Set(['aw-1']) }), null);
  assert.equal(pick(stale(), { isResuming: () => true }), null);
});

test('a recent relaunch counts as activity', () => {
  const picked = nextSessionToRefresh([stale()], { codeVersion: 'new', now, entryFor: () => ({ relaunchedAt: now - 1000 }) });
  assert.equal(picked, null);
});

test('one session per call', () => {
  const picked = nextSessionToRefresh([stale(), stale({ sessionId: 's2', tmux: 'aw-2' })], { codeVersion: 'new', now });
  assert.equal(picked.sessionId, 's1');
});
