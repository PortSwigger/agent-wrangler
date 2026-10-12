import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoardOpen } from './board-open.js';

test('a pending request is claimed once, by the card it was for', () => {
  const b = createBoardOpen();
  const onClose = () => {};
  b.request('s1', { diff: true, onClose });
  assert.deepEqual(b.claim('s1'), { sessionId: 's1', diff: true, onClose });
  assert.equal(b.claim('s1'), null, 'already claimed');
});

test('another card selected first drops the pending request', () => {
  const b = createBoardOpen();
  b.request('s1');
  assert.equal(b.claim('s2'), null);
  assert.equal(b.claim('s1'), null, 'a later restore of s1 does not land on it');
});

test('drop forgets the pending request and names its card', () => {
  const b = createBoardOpen();
  assert.equal(b.drop(), null);
  b.request('s1');
  assert.equal(b.drop(), 's1');
  assert.equal(b.claim('s1'), null);
});

test('a later request replaces a pending one', () => {
  const b = createBoardOpen();
  b.request('s1', { diff: true });
  b.request('s2');
  assert.equal(b.claim('s1'), null);
});

test('onClose fires once, for the watched panel only', () => {
  const b = createBoardOpen();
  let closed = 0;
  b.watchDiff('s1', () => { closed += 1; });
  b.diffClosed('s2');
  assert.equal(closed, 0);
  b.diffClosed('s1');
  b.diffClosed('s1');
  assert.equal(closed, 1);
});

test('a new watch replaces the old one without firing it', () => {
  const b = createBoardOpen();
  const fired = [];
  b.watchDiff('s1', () => fired.push('s1'));
  b.watchDiff('s2', () => fired.push('s2'));
  b.diffClosed('s1');
  b.diffClosed('s2');
  assert.deepEqual(fired, ['s2']);
});

test('a watch with no onClose clears the old one', () => {
  const b = createBoardOpen();
  const fired = [];
  b.watchDiff('s1', () => fired.push('s1'));
  b.watchDiff('s1', null);
  b.diffClosed('s1');
  assert.deepEqual(fired, []);
});
