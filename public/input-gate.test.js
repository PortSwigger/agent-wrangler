import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointerOnly, createInputGates } from './input-gate.js';

test('pointerOnly passes mouse and focus reports, alone or in a burst, and nothing typed', () => {
  assert.equal(pointerOnly('\x1b[<64;10;5M'), true); // SGR wheel up
  assert.equal(pointerOnly('\x1b[<65;10;5M\x1b[<65;10;5M\x1b[<65;10;5M'), true);
  assert.equal(pointerOnly('\x1b[<0;3;4M\x1b[<0;3;4m'), true); // SGR click
  assert.equal(pointerOnly('\x1b[M`!!'), true); // X10 wheel
  assert.equal(pointerOnly('\x1b[64;10;5M'), true); // urxvt
  assert.equal(pointerOnly('\x1b[I'), true);
  assert.equal(pointerOnly('\x1b[O'), true);
  for (const typed of ['a', '\r', '\x7f', '\x03', '\x1b', '\x1b[A', 'hello\r', '\x1b[200~paste\x1b[201~', '\x1b[<64;10;5Mx', '']) {
    assert.equal(pointerOnly(typed), false, JSON.stringify(typed));
  }
});

test('a locked session drops typed input, passes the wheel and is told once per lock', () => {
  let cold = new Set(['a']);
  const told = [];
  const gates = createInputGates({
    gateFor: (s) => (cold.has(s.sessionId) ? { key: 'x:g', reason: 'Cache expired', label: '' } : null),
    notify: (sid, g) => told.push([sid, g.reason]),
  });
  const sessions = [{ sessionId: 'a' }, { sessionId: 'b' }];
  assert.equal(gates.refresh(sessions), true);
  assert.equal(gates.refresh(sessions), false);
  assert.equal(gates.get('a').reason, 'Cache expired');
  assert.equal(gates.get('b'), null);
  assert.equal(gates.get(null), null);
  assert.equal(gates.allow('a', 'x'), false);
  assert.equal(gates.allow('a', '\r'), false);
  assert.equal(gates.allow('a', '\x1b[<65;1;1M'), true);
  assert.equal(gates.allow('b', 'x'), true);
  assert.equal(gates.allow(null, 'x'), true);
  assert.deepEqual(told, [['a', 'Cache expired']]);
  // Unlock re-arms the notice for the next lock.
  cold = new Set();
  assert.equal(gates.refresh(sessions), true);
  assert.equal(gates.allow('a', 'x'), true);
  cold = new Set(['a']);
  gates.refresh(sessions);
  assert.equal(gates.allow('a', 'x'), false);
  assert.equal(told.length, 2);
});
