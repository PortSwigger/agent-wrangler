import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusReturnTarget } from './terminal-dialog.js';

const el = ({ id = '', tagName = 'DIV', open = false, hidden = false, connected = true, inside = null, buttons = {} } = {}) => ({
  id, tagName, open, isConnected: connected,
  classList: { contains: (c) => c === 'hidden' && hidden },
  closest: () => inside,
  querySelector: (sel) => buttons[sel] ?? null,
});

const docWith = (modals, body = el()) => ({ body, querySelectorAll: () => modals });

test('focus returns to the element that opened the dialog while it is still there', () => {
  const opener = el();
  assert.equal(focusReturnTarget(opener, docWith([])), opener);
});

test('a redrawn opener falls back to the open Settings modal, not the terminal dialog', () => {
  const done = el({ id: 'settings-close' });
  const settings = el({ id: 'settings-modal', buttons: { 'button.primary:not([disabled])': done } });
  const terminal = el({ id: 'terminal-modal', tagName: 'DIALOG', open: true, buttons: { 'button.primary:not([disabled])': el() } });
  const closed = el({ id: 'fork-modal', hidden: true, buttons: { 'button.primary:not([disabled])': el() } });
  assert.equal(focusReturnTarget(el({ connected: false }), docWith([closed, settings, terminal])), done);
});

test('an opener inside a hidden or inert subtree is not focusable, and body is no opener', () => {
  const doc = docWith([]);
  assert.equal(focusReturnTarget(el({ inside: el() }), doc), null);
  assert.equal(focusReturnTarget(doc.body, doc), null);
  assert.equal(focusReturnTarget(null, doc), null);
});

test('a redrawn opener returns focus to the modal it sat in, even when another modal opened later', async () => {
  const done = el({ id: 'settings-close' });
  const settings = el({ id: 'settings-modal', buttons: { 'button.primary:not([disabled])': done } });
  const later = el({ id: 'confirm-modal', buttons: { 'button.primary:not([disabled])': el() } });
  assert.equal(focusReturnTarget(el({ connected: false }), docWith([settings, later]), settings), done);
  const closedScope = el({ id: 'settings-modal', hidden: true });
  assert.equal(focusReturnTarget(el({ connected: false }), docWith([later]), closedScope), later.querySelector('button.primary:not([disabled])'));
});
