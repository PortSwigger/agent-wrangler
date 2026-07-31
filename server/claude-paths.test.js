import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOf, liveStatusDecision } from './claude-paths.js';

test('statusOf maps Claude session-file statuses to board states', () => {
  assert.equal(statusOf('busy'), 'working');
  assert.equal(statusOf('waiting'), 'needs-you');
  assert.equal(statusOf('idle'), 'idle');
  // 'shell' = a Bash tool is running. Must read as working, never idle, so the
  // suspend reconcile can't tear down a session mid-command.
  assert.equal(statusOf('shell'), 'working');
  assert.equal(statusOf(undefined), 'unknown');
  assert.equal(statusOf('something-new'), 'unknown');
});

test('liveStatusDecision: recognized statuses map directly (no scrape)', () => {
  assert.equal(liveStatusDecision('busy'), 'working');
  assert.equal(liveStatusDecision('shell'), 'working');
  assert.equal(liveStatusDecision('waiting'), 'needs-you');
  assert.equal(liveStatusDecision('idle'), 'idle');
});

test('liveStatusDecision: a reported-but-unrecognized status surfaces as unknown, never scrape', () => {
  // A new Claude status we do not map yet must show in the UI (as unknown → "?"),
  // not be guessed by a pane scrape — that is what keeps it visible and unsuspendable.
  assert.equal(liveStatusDecision('thinking'), 'unknown');
  assert.equal(liveStatusDecision('compacting'), 'unknown');
});

test('liveStatusDecision: only an absent/blank status falls back to a pane scrape', () => {
  assert.equal(liveStatusDecision(undefined), 'scrape');
  assert.equal(liveStatusDecision(null), 'scrape');
  assert.equal(liveStatusDecision(''), 'scrape');
  assert.equal(liveStatusDecision('   '), 'scrape');
});
