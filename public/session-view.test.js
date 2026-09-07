import test from 'node:test';
import assert from 'node:assert/strict';
import { viewForSession } from './session-view.js';

test('a saved per-session choice wins over the board default', () => {
  assert.equal(viewForSession('chat', false), 'chat');
  assert.equal(viewForSession('terminal', true), 'terminal');
});

test('with no saved choice the board default decides', () => {
  assert.equal(viewForSession(null, true), 'chat');
  assert.equal(viewForSession(undefined, false), 'terminal');
});

test('an unrecognised stored value falls back to the default rather than being trusted', () => {
  // localStorage is human-editable and survives a downgrade, so a value this
  // build does not know must not reach the renderer as a view name.
  assert.equal(viewForSession('kanban', true), 'chat');
});
