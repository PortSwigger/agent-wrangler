import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prCheckToastOptions, prAlertToastOptions, prToastSuppressed, PR_TOAST_MS } from './pr-check-notification.js';

test('failing session checks offer a session action for 15 seconds', () => {
  const opened = [];
  const options = prCheckToastOptions('failing', 'session', 's1', (id) => opened.push(id));

  assert.equal(options.duration, 15000);
  assert.equal(options.actions[0].label, 'View session');
  options.actions[0].onClick();
  assert.deepEqual(opened, ['s1']);
});

test('task check alerts have no session action', () => {
  const options = prCheckToastOptions('failing', 'task', 't1', () => assert.fail());

  assert.equal(options.duration, 15000);
  assert.deepEqual(options.actions, []);
});

test('review changes requested use the actionable error toast', () => {
  const options = prCheckToastOptions('changes-requested', 'session', 's2', () => {});

  assert.equal(options.duration, 15000);
  assert.equal(options.actions[0].label, 'View session');
});

test('non-error check statuses keep the default toast behavior', () => {
  assert.equal(prCheckToastOptions('passing', 'session', 's3', () => {}), undefined);
});

test('conflict, review-thread and merge-failure toasts expire like the checks toast', () => {
  assert.equal(prAlertToastOptions().duration, PR_TOAST_MS);
});

test('a PR toast is suppressed only when the session was nudged and the setting is on', () => {
  assert.equal(prToastSuppressed({ nudged: true }, true), true);
  assert.equal(prToastSuppressed({ nudged: true }, false), false);
  assert.equal(prToastSuppressed({ nudged: false }, true), false);
  assert.equal(prToastSuppressed({}, true), false);
});
