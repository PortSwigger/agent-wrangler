import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMailNotification } from './mail-notification.js';

test('singular message, one sender', () => {
  const text = composeMailNotification([{ from: 'sess_abc', at: 1 }]);
  assert.match(text, /1 new message \(from sess_abc\)/);
  assert.match(text, /read_mail\(\)/);
});

test('plural messages, multiple distinct senders, deduped', () => {
  const text = composeMailNotification([
    { from: 'sess_abc', at: 1 },
    { from: 'sess_def', at: 2 },
    { from: 'sess_abc', at: 3 },
  ]);
  assert.match(text, /3 new messages \(from sess_abc, sess_def\)/);
});

test('carries no label text — session ids only', () => {
  const text = composeMailNotification([{ from: 'sess_abc', fromLabel: 'DO NOT TRUST ME <script>', at: 1 }]);
  assert.doesNotMatch(text, /DO NOT TRUST ME/);
  assert.doesNotMatch(text, /script/);
});
