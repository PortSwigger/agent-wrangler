import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMailNotification } from './mail-notification.js';

test('singular message', () => {
  const text = composeMailNotification([{ from: 'sess_abc', at: 1 }]);
  assert.match(text, /1 message, read when convenient\./);
});

test('plural messages', () => {
  const text = composeMailNotification([
    { from: 'sess_abc', at: 1 },
    { from: 'sess_def', at: 2 },
  ]);
  assert.match(text, /2 messages, read when convenient\./);
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

test('does not instruct read_mail() itself — the mail skill\'s always-on nudge carries that, not a duplicated line here', () => {
  const text = composeMailNotification([{ from: 'sess_abc', at: 1 }]);
  assert.doesNotMatch(text, /read_mail/);
});

test('an identity-less sender does not change the notification at all (no more "(from )")', () => {
  const text = composeMailNotification([{ from: null, at: 1 }]);
  assert.match(text, /1 message, read when convenient\./);
});
