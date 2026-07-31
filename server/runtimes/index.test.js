import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFor, DEFAULT_RUNTIME } from './index.js';

test('runtimeFor: absent id resolves to local', () => {
  assert.equal(runtimeFor(undefined).id, 'local');
  assert.equal(runtimeFor('').id, 'local');
  assert.equal(DEFAULT_RUNTIME, 'local');
});

test('runtimeFor: local is a pass-through wrapLaunch', async () => {
  const cmd = await runtimeFor('local').wrapLaunch({ inner: 'claude --foo', cwd: '/x', sessionId: 's1' });
  assert.equal(cmd, 'claude --foo');
});

test('runtimeFor: unknown runtime id throws (fails closed)', () => {
  assert.throws(() => runtimeFor('bogus'), /unknown runtime/i);
});

test('local: no read hooks, does not skip the host resume guard', () => {
  const l = runtimeFor('local');
  assert.equal(l.readLive, undefined);
  assert.equal(l.analyze, undefined);
  assert.equal(l.skipsHostResumeGuard ?? false, false);
});

test('devcontainer: skips the host resume guard', () => {
  assert.equal(runtimeFor('devcontainer').skipsHostResumeGuard, true);
});
