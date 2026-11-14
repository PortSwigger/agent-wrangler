import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BOARD_ACTIONS, actionFor, toActionCall } from './deck-actions.js';
import { CORE_ACTIONS } from '../server/deck/actions.js';

const here = new URL('./', import.meta.url);

test('every board action is the name the deck gives that handler', () => {
  for (const [type, action] of Object.entries(BOARD_ACTIONS)) assert.equal(CORE_ACTIONS[type], action, type);
});

// A message type the board sends with no row here would go nowhere: send()
// refuses a type it cannot name.
test('every core control type the board sends has a board action', () => {
  const missing = new Set();
  for (const f of readdirSync(here).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) {
    const src = readFileSync(new URL(f, here), 'utf8');
    for (const m of src.matchAll(/type: *'([a-z-]+)'/g)) if (CORE_ACTIONS[m[1]] && !BOARD_ACTIONS[m[1]]) missing.add(`${f}: ${m[1]}`);
  }
  assert.deepEqual([...missing], []);
});

test('an extension frame is named under its own id; an unknown core type is not named at all', () => {
  assert.equal(actionFor({ type: 'todo-add' }, 'todos'), 'ext.todos.todo-add');
  assert.equal(actionFor({ type: 'todo-add' }), null);
  assert.equal(actionFor({ type: 'fork' }), 'session.fork');
  assert.equal(actionFor(null), null);
});

test('a session action acts on the message sessionId; other fields ride as args', () => {
  assert.deepEqual(toActionCall({ type: 'fork', sessionId: 's1', prompt: 'go' }), {
    action: 'session.fork', session: 's1', args: { sessionId: 's1', prompt: 'go' },
  });
  assert.deepEqual(toActionCall({ type: 'task-create', name: 'T', sessionId: 's1' }), {
    action: 'task.create', session: null, args: { name: 'T', sessionId: 's1' },
  });
  assert.equal(toActionCall({ type: 'adopt-conversation', sessionId: 'c1' }).session, null, 'not a session yet, so never looked up as one');
});
