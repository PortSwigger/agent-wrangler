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

for (const status of ['passing', 'awaiting-review', 'failing', 'changes-requested']) {
  for (const scope of ['session', 'task']) {
    test(`${scope} ${status} checks link to their owner and preserve duration`, () => {
      const opened = [];
      const options = prCheckToastOptions(status, scope, 'owner',
        (id) => opened.push(['session', id]), (id) => opened.push(['task', id]));
      assert.equal(options.duration, ['failing', 'changes-requested'].includes(status) ? PR_TOAST_MS : undefined);
      assert.equal(options.actions[0].label, scope === 'session' ? 'View session' : 'View task');
      options.actions[0].onClick();
      assert.deepEqual(opened, [[scope, 'owner']]);
    });
  }
}

for (const event of ['conflicts', 'review threads', 'merge failure']) {
  for (const scope of ['session', 'task']) {
    test(`${event} links to its ${scope} for 15 seconds`, () => {
      const opened = [];
      const options = prAlertToastOptions(scope, 'owner',
        (id) => opened.push(['session', id]), (id) => opened.push(['task', id]));
      assert.equal(options.duration, PR_TOAST_MS);
      options.actions[0].onClick();
      assert.deepEqual(opened, [[scope, 'owner']]);
    });
  }
}

test('unscoped alerts retain their duration without a navigation action', () => {
  assert.deepEqual(prAlertToastOptions(), { duration: PR_TOAST_MS, actions: [] });
});

test('a PR toast is suppressed only when the session was nudged and the setting is on', () => {
  assert.equal(prToastSuppressed({ nudged: true }, true), true);
  assert.equal(prToastSuppressed({ nudged: true }, false), false);
  assert.equal(prToastSuppressed({ nudged: false }, true), false);
  assert.equal(prToastSuppressed({}, true), false);
});

const { readFileSync } = await import('node:fs');
const { runInNewContext } = await import('node:vm');
const helpers = await import('./pr-check-notification.js');
const snooze = await import('./notification-snooze.js');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const handlers = app.slice(app.indexOf('const PR_CHECK_TEXT ='), app.indexOf('// Re-theme a live terminal'));

for (const [handler, variants] of [
  ['onPrChecks', ['passing', 'awaiting-review', 'failing', 'changes-requested'].map(status => ({ status }))],
  ['onPrMerge', [{ ok: true }, { ok: false }]],
  ['onPrDirty', [{}]],
  ['onPrComments', [{}]],
]) {
  for (const variant of variants) {
    for (const scope of ['session', 'task']) {
      test(`${handler} ${JSON.stringify(variant)} navigates to its ${scope}`, () => {
        const opened = [];
        const notifications = [];
        const toasts = [];
        class Notification {
          static permission = 'granted';
          constructor() { notifications.push(this); }
        }
        const notifSnooze = snooze.createSnoozeStore({ storage: null, now: () => 0 });
        const context = {
          ...helpers, ...snooze, notifSnooze, Notification, window: { Notification, focus() {} },
          focusSuppresses: () => false, suppressNudgedPrToasts: false,
          openSessionInBoard: id => opened.push(['session', id]),
          openTaskInBoard: id => opened.push(['task', id]),
          toast: (...args) => toasts.push(args), flashPr() {},
        };
        const url = 'https://github.com/acme/widgets/pull/1';
        runInNewContext(`${handlers}\n${handler}(${JSON.stringify({ ...variant, scope, sessionId: 'owner', number: 1, url })});`, context);
        const [, isErr, options] = toasts[0];
        const expectedErr = handler === 'onPrChecks'
          ? ['failing', 'changes-requested'].includes(variant.status)
          : handler === 'onPrMerge' ? !variant.ok : true;
        assert.equal(isErr, expectedErr);
        assert.equal(options.duration, expectedErr ? PR_TOAST_MS : undefined);
        assert.equal(options.actions[0].label, scope === 'session' ? 'View session' : 'View task');
        options.actions[0].onClick();
        assert.deepEqual(opened, [[scope, 'owner']]);
        assert.deepEqual(Array.from(options.actions.slice(1), (a) => a.label), ['Snooze 10m', 'Snooze all']);
        options.actions[1].onClick();
        assert.equal(notifSnooze.isSnoozed([`pr:${url}`]), true);
        if (handler !== 'onPrMerge') {
          notifications[0].onclick();
          assert.deepEqual(opened, [[scope, 'owner'], [scope, 'owner']]);
        } else {
          assert.equal(notifications.length, 0);
        }
      });
    }
  }
}

for (const handler of ['onPrChecks', 'onPrMerge', 'onPrDirty', 'onPrComments']) {
  for (const suppression of ['focus', 'nudged']) {
    test(`${handler} preserves ${suppression} suppression`, () => {
      runInNewContext(`${handlers}\n${handler}({ scope: 'session', sessionId: 'owner', nudged: true });`, {
        ...helpers,
        focusSuppresses: () => suppression === 'focus',
        suppressNudgedPrToasts: suppression === 'nudged',
        toast: () => assert.fail('suppressed event must not toast'),
      });
    });
  }
}
