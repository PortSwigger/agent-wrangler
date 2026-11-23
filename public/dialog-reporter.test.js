import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDialogReporter } from './dialog-reporter.js';

const modal = (id, open) => ({ id, tagName: 'DIV', hidden: false, classList: { contains: (c) => c === 'hidden' && !open } });

function reporter(els) {
  const sent = [];
  const doc = { querySelectorAll: () => els };
  const r = createDialogReporter({ doc, send: (m) => { sent.push(m); }, MutationObserverImpl: null });
  r.check();
  return sent;
}

test('an open Settings dialog does not count toward the restart hold', () => {
  assert.deepEqual(reporter([modal('settings-modal', true), modal('dispatch-modal', false)]), [{ type: 'dialogs', open: 0 }]);
});

test('another open dialog still counts while Settings is open', () => {
  assert.deepEqual(reporter([modal('settings-modal', true), modal('dispatch-modal', true)]), [{ type: 'dialogs', open: 1 }]);
});
