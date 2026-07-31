import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmuxSocketArgs, socketsToScan, socketForEntry, generateSocketName } from './tmux-socket.js';

test('tmuxSocketArgs: default ("" / undefined) → no -L; named → -L <name>', () => {
  assert.deepEqual(tmuxSocketArgs(''), []);
  assert.deepEqual(tmuxSocketArgs(undefined), []);
  assert.deepEqual(tmuxSocketArgs('aw-abc'), ['-L', 'aw-abc']);
});

test('socketForEntry: a recorded socket wins; absent (legacy) → the legacy socket (default "")', () => {
  assert.equal(socketForEntry({ socket: 'aw-x' }), 'aw-x');
  assert.equal(socketForEntry({}), ''); // legacy session, default socket
  assert.equal(socketForEntry(undefined), '');
  // The legacy socket is overridable (for isolated migration testing); a recorded
  // socket still wins over it.
  assert.equal(socketForEntry({}, 'aw-fakedefault'), 'aw-fakedefault');
  assert.equal(socketForEntry({ socket: 'aw-x' }, 'aw-fakedefault'), 'aw-x');
});

test('socketsToScan: just the instance socket when no legacy entries', () => {
  const entries = [{ socket: 'aw-x' }, { socket: 'aw-x', archivedAt: 1 }];
  assert.deepEqual(socketsToScan(entries, 'aw-x'), ['aw-x']);
});

test('socketsToScan: adds the default socket while a non-archived legacy entry exists', () => {
  const entries = [{ socket: 'aw-x' }, { /* legacy: no socket */ }];
  assert.deepEqual(socketsToScan(entries, 'aw-x').sort(), ['', 'aw-x']);
});

test('socketsToScan: uses the overridable legacy socket (isolated migration testing)', () => {
  const entries = [{ socket: 'aw-x' }, { /* legacy */ }];
  assert.deepEqual(socketsToScan(entries, 'aw-x', 'aw-fakedefault').sort(), ['aw-fakedefault', 'aw-x']);
});

test('socketsToScan: an archived legacy entry does NOT keep the default socket in scope', () => {
  const entries = [{ archivedAt: 123 }]; // legacy but archived → tmux already gone
  assert.deepEqual(socketsToScan(entries, 'aw-x'), ['aw-x']);
});

test('generateSocketName: aw- prefixed, unique', () => {
  const a = generateSocketName();
  const b = generateSocketName();
  assert.match(a, /^aw-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});
