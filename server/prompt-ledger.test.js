import test from 'node:test';
import assert from 'node:assert/strict';
import { notePrompt, takePrompt, promptSourceForReason, TTL_MS, _resetPromptLedgerForTest } from './prompt-ledger.js';

test('a noted send is matched once by the same text, whitespace and paste wrapper aside', () => {
  _resetPromptLedgerForTest();
  notePrompt('fix  the\nlogin bug <pasted_content id="a">trace</pasted_content id="a">', 'composer', { now: 0 });
  assert.deepEqual(takePrompt('fix the login bug trace', { now: 1 }), { source: 'composer', pasted: true });
  assert.equal(takePrompt('fix the login bug trace', { now: 2 }), null);
});

test('the same text sent twice matches twice, and a note expires', () => {
  _resetPromptLedgerForTest();
  notePrompt('📬 New mail', 'mail', { now: 0 });
  notePrompt('📬 New mail', 'mail', { now: 1 });
  assert.equal(takePrompt('📬 New mail', { now: 2 }).source, 'mail');
  assert.equal(takePrompt('📬 New mail', { now: 3 }).source, 'mail');
  notePrompt('late', 'mail', { now: 0 });
  assert.equal(takePrompt('late', { now: TTL_MS + 1 }), null);
});

test('a raw pane paste only fills in when no caller named the source, and a named note wins either way', () => {
  _resetPromptLedgerForTest();
  notePrompt('yes', 'composer', { now: 0 });
  notePrompt('yes', 'mail', { now: 5, fallback: true });
  assert.equal(takePrompt('yes', { now: 10 }).source, 'composer');
  assert.equal(takePrompt('yes', { now: 11 }), null);
  notePrompt('ship it', 'mail', { now: 20, fallback: true });
  notePrompt('ship it', 'schedule', { now: 21 });
  assert.equal(takePrompt('ship it', { now: 22 }).source, 'schedule');
  assert.equal(takePrompt('ship it', { now: 23 }), null);
});

test('only a hash is kept: nothing in the ledger reads back as text', () => {
  _resetPromptLedgerForTest();
  notePrompt('the payroll password is hunter2', 'composer', { now: 0 });
  assert.equal(takePrompt('something else', { now: 1 }), null);
});

test('delivery reasons map to prompt sources', () => {
  assert.equal(promptSourceForReason('message'), 'composer');
  assert.equal(promptSourceForReason('ext:jobs'), 'extension');
  assert.equal(promptSourceForReason('schedule'), 'schedule');
  assert.equal(promptSourceForReason('status-notice'), 'mail');
  assert.equal(promptSourceForReason('mail'), 'mail');
});
