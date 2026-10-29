import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onBoard } from './off-board.js';

test('an off-board card is left out, every other card kept in order', () => {
  const sessions = [
    { sessionId: 'a' },
    { sessionId: 'b', offBoard: 'jobs' },
    { sessionId: 'c', offBoard: null },
  ];
  assert.deepEqual(onBoard(sessions).map((s) => s.sessionId), ['a', 'c']);
});
