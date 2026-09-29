import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMailNotification } from './mail-notification.js';

test('singular message', () => {
  const text = composeMailNotification([{ from: 'sess_abc', at: 1 }]);
  assert.match(text, /1 message\. Call read_mail now, then continue your work\./);
});

test('plural messages', () => {
  const text = composeMailNotification([
    { from: 'sess_abc', at: 1 },
    { from: 'sess_def', at: 2 },
  ]);
  assert.match(text, /2 messages\. Call read_mail now, then continue your work\./);
});

test('carries the [Agent Wrangler] prefix, like every other server-originated pane paste', () => {
  const text = composeMailNotification([{ from: 'sess_abc', at: 1 }]);
  assert.match(text, /^\[Agent Wrangler\] /);
});

test('carries no sender identity at all — not an id, not a label, not a count of distinct senders', () => {
  const text = composeMailNotification([
    { from: 'sess_abc', fromLabel: 'DO NOT TRUST ME <script>', at: 1 },
    { from: 'sess_def', at: 2 },
  ]);
  assert.doesNotMatch(text, /sess_abc/);
  assert.doesNotMatch(text, /sess_def/);
  assert.doesNotMatch(text, /DO NOT TRUST ME/);
  assert.doesNotMatch(text, /from/i);
});

test('explicitly asks the recipient to read mail in the wake turn', () => {
  const text = composeMailNotification([{ from: 'sess_abc', at: 1 }]);
  assert.match(text, /Call read_mail now/);
});

test('an identity-less sender does not change the notification at all (no more "(from )")', () => {
  const text = composeMailNotification([{ from: null, at: 1 }]);
  assert.match(text, /1 message\. Call read_mail now, then continue your work\./);
});
