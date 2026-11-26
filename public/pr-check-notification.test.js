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
        const context = {
          ...helpers, Notification, window: { Notification, focus() {} },
          focusSuppresses: () => false, suppressNudgedPrToasts: false, holdNotification: () => false, trackPopup: (m, n) => { n.trackedFor = m.number; },
          openSessionInBoard: id => opened.push(['session', id]),
          openTaskInBoard: id => opened.push(['task', id]),
          toast: (...args) => toasts.push(args), flashPr() {},
        };
        const msg = { ...variant, scope, sessionId: 'owner', number: 1 };
        runInNewContext(`${handlers}\n${handler}(${JSON.stringify(msg)});`, context);
        const [, isErr, options] = toasts[0];
        assert.equal(JSON.stringify(options.snooze), JSON.stringify(msg));
        const expectedErr = handler === 'onPrChecks'
          ? ['failing', 'changes-requested'].includes(variant.status)
          : handler === 'onPrMerge' ? !variant.ok : true;
        assert.equal(isErr, expectedErr);
        assert.equal(options.duration, expectedErr ? PR_TOAST_MS : undefined);
        assert.equal(options.actions[0].label, scope === 'session' ? 'View session' : 'View task');
        options.actions[0].onClick();
        assert.deepEqual(opened, [[scope, 'owner']]);
        if (handler !== 'onPrMerge') {
          assert.equal(notifications[0].trackedFor, 1);
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

for (const handler of ['onPrChecks', 'onPrMerge', 'onPrDirty', 'onPrComments']) {
  test(`${handler} holds the notification instead of showing it during Snooze all`, () => {
    const held = [];
    runInNewContext(`${handlers}\n${handler}({ scope: 'session', sessionId: 'owner', url: 'u', number: 1 });`, {
      ...helpers,
      focusSuppresses: () => false, suppressNudgedPrToasts: false,
      holdNotification: (msg, resurfaced) => { held.push([msg.url, resurfaced]); return true; },
      toast: () => assert.fail('a held event must not toast'),
      flashPr: () => assert.fail('a held event must not flash'),
    });
    assert.deepEqual(held, [['u', false]]);
  });
}
