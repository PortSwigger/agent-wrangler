import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from './events.js';

const errs = () => {
  const errors = [];
  return { errors, onError: (...a) => errors.push(a) };
};

test('delivers the payload to every subscriber of the name, and only that name', () => {
  const bus = createEventBus();
  const seen = [];
  bus.on('x', (p) => seen.push(['a', p]));
  bus.on('x', (p) => seen.push(['b', p]));
  bus.on('y', (p) => seen.push(['y', p]));
  assert.equal(bus.emit('x', { n: 1 }), 2);
  assert.deepEqual(seen, [['a', { n: 1 }], ['b', { n: 1 }]]);
  assert.equal(bus.emit('nobody-listens', 1), 0);
});

test('on() returns an unsubscribe; validates its arguments', () => {
  const bus = createEventBus();
  const seen = [];
  const off = bus.on('x', (p) => seen.push(p));
  bus.emit('x', 1);
  off();
  bus.emit('x', 2);
  assert.deepEqual(seen, [1]);
  assert.throws(() => bus.on('', () => {}), /name must be a non-empty string/);
  assert.throws(() => bus.on('x', null), /handler must be a function/);
});

test('error isolation: a throwing or rejecting handler is reported per handler and never stops the rest or the emitter', async () => {
  const { errors, onError } = errs();
  const bus = createEventBus({ onError });
  const seen = [];
  bus.on('x', () => { throw new Error('sync'); }, 'one');
  bus.on('x', async () => { throw new Error('async'); }, 'two');
  bus.on('x', (p) => seen.push(p), 'three');
  assert.doesNotThrow(() => bus.emit('x', 'payload'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['payload']);
  assert.equal(errors.length, 2);
  assert.match(errors[0][0], /handler for "x" \(one\) threw/);
  assert.match(errors[1][0], /handler for "x" \(two\) rejected/);
});

test('emit does not wait on handlers (a slow subscriber cannot stall the producer)', () => {
  const bus = createEventBus();
  let finished = false;
  bus.on('x', () => new Promise((r) => setTimeout(() => { finished = true; r(); }, 30)));
  bus.emit('x');
  assert.equal(finished, false);
});

test('offOwner drops everything one owner subscribed, leaving the others', () => {
  const bus = createEventBus();
  const seen = [];
  bus.on('x', () => seen.push('a'), 'a');
  bus.on('y', () => seen.push('a-y'), 'a');
  bus.on('x', () => seen.push('b'), 'b');
  bus.on('x', () => seen.push('core'));
  bus.offOwner('a');
  bus.emit('x');
  bus.emit('y');
  assert.deepEqual(seen, ['b', 'core']);
});

test('no delivery to an owner reported inactive (a disabled extension), even before its subscriptions are dropped', () => {
  const active = new Set(['a', 'b']);
  const bus = createEventBus({ isActive: (id) => active.has(id) });
  const seen = [];
  bus.on('x', () => seen.push('a'), 'a');
  bus.on('x', () => seen.push('b'), 'b');
  bus.on('x', () => seen.push('core')); // ownerless (core) subscribers are always delivered to
  active.delete('a');
  assert.equal(bus.emit('x'), 2);
  assert.deepEqual(seen, ['b', 'core']);
});

test('hasListeners: true only while some ACTIVE owner (or core) would hear the event', () => {
  const active = new Set(['a']);
  const bus = createEventBus({ isActive: (id) => active.has(id) });
  assert.equal(bus.hasListeners('x'), false);
  bus.on('x', () => {}, 'a');
  assert.equal(bus.hasListeners('x'), true);
  active.delete('a');
  assert.equal(bus.hasListeners('x'), false);
  bus.on('x', () => {});
  assert.equal(bus.hasListeners('x'), true);
});
